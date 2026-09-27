import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, expect, it } from "vitest";
import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";
import { createDynamoClients, tableNames } from "./dynamo.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";
import { createBlackboardReporting, reportingDelivery } from "../blackboard-reporting.ts";
import { createControlPlaneState } from "../control-plane-state.ts";
import { repairBlackboardReporting } from "../blackboard-repair.ts";
import { config, terminal } from "../../test-helpers/blackboard-reporting-fixtures.ts";

const ctx = createDynamoTestCtx("BbErrors");
const NOW = "2026-09-27T20:00:00.000Z";
beforeEach(async () => {
  await ctx.storage!.clearAll();
});

function storageWithUnavailableUpdates() {
  const names = tableNames(ctx.prefix);
  const { doc } = createDynamoClients();
  return new DynamoPlaneStorage(
    {
      send: (command: Parameters<typeof doc.send>[0]) =>
        doc.send(
          command instanceof UpdateCommand
            ? new UpdateCommand({
                ...command.input,
                TableName: `${command.input.TableName}-missing`,
              })
            : command,
        ),
    } as never,
    names,
  );
}

it("settlement of an absent retained delivery cannot create a phantom receipt or dead letter", async () => {
  const storage = ctx.storage!;
  const fence = { id: "missing", owner: "worker", leaseId: "lease", now: NOW };
  expect(await storage.completeWebhookDelivery(fence)).toBe(false);
  expect(
    await storage.failWebhookDelivery({
      ...fence,
      failureCode: "transient-failure",
      nextAttemptAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
    }),
  ).toBeNull();
  expect(
    await storage.deadLetterWebhookDelivery({ ...fence, failureCode: "delivery-rejected" }),
  ).toBe(false);
  expect(await storage.deadLetterExhaustedWebhookDelivery({ id: fence.id, now: NOW })).toBe(false);
  expect(await storage.getWebhookDelivery(fence.id)).toBeNull();
});

it("propagates real missing-table failures for admission and both repair writes", async () => {
  const missingUpdate = storageWithUnavailableUpdates();
  await expect(missingUpdate.recordBlackboardAdmissionBlock("session", true)).rejects.toMatchObject(
    {
      name: "ResourceNotFoundException",
    },
  );
  await expect(missingUpdate.claimReportingRepair("completed", "one", NOW)).rejects.toMatchObject({
    name: "ResourceNotFoundException",
  });
  const checkpoint = (await ctx.storage!.claimReportingRepair("completed", "one", NOW))!;
  await expect(missingUpdate.completeReportingRepair(checkpoint, null, NOW)).rejects.toMatchObject({
    name: "ResourceNotFoundException",
  });
});

it("propagates an unavailable settlement table without treating an owned lease as lost", async () => {
  const storage = ctx.storage!;
  const prior = terminal();
  const reporting = createBlackboardReporting(config());
  const delivery = reportingDelivery(prior)!;
  const enqueued = await storage.enqueueWebhookDelivery({
    sessionId: prior.id,
    repositoryId: prior.repositoryId,
    attemptId: prior.attemptId ?? null,
    status: prior.status,
    occurredAt: prior.completedAt!,
    destination: delivery.destination,
    maxAttempts: delivery.maxAttempts,
    feedback: reporting.snapshot(prior, delivery.event.id),
  });
  const fence = {
    id: enqueued.delivery.id,
    owner: "worker",
    leaseId: "lease",
    now: NOW,
    leaseExpiresAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
  };
  expect(await storage.claimWebhookDelivery(fence)).toMatchObject({ state: "leased" });
  const unavailable = storageWithUnavailableUpdates();
  await expect(unavailable.completeWebhookDelivery(fence)).rejects.toMatchObject({
    name: "ResourceNotFoundException",
  });
  await expect(
    unavailable.failWebhookDelivery({
      ...fence,
      failureCode: "transient-failure",
      nextAttemptAt: new Date(Date.parse(NOW) + 120_000).toISOString(),
    }),
  ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  await expect(
    unavailable.deadLetterWebhookDelivery({ ...fence, failureCode: "delivery-rejected" }),
  ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  await expect(
    unavailable.deadLetterExhaustedWebhookDelivery({ id: fence.id, now: NOW }),
  ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  expect(await storage.getWebhookDelivery(fence.id)).toMatchObject({
    state: "leased",
    leaseOwner: "worker",
    leaseId: "lease",
  });
});

it("restarts repair from the beginning when a retained cursor has malformed nested attributes", async () => {
  const storage = ctx.storage!;
  const first = (await storage.claimReportingRepair("completed", "one", NOW))!;
  expect(await storage.completeReportingRepair(first, null, NOW)).toBe(true);
  const { doc } = createDynamoClients();
  await doc.send(
    new UpdateCommand({
      TableName: tableNames(ctx.prefix).reportingRepairCheckpoints,
      Key: { status: "completed" },
      UpdateExpression: "SET #cursor = :cursor",
      ExpressionAttributeNames: { "#cursor": "cursor" },
      ExpressionAttributeValues: {
        ":cursor": [{ id: "partition", exhausted: false, checkpoint: { a: "x", b: "y", c: 42 } }],
      },
    }),
  );
  const restarted = await storage.claimReportingRepair("completed", "two", NOW);
  expect(restarted?.cursor).toBeNull();
  expect(restarted?.revision).toBe(first.revision + 1);
});

it("propagates a real unavailable Sessions index during repair instead of advancing the cursor", async () => {
  const names = tableNames(ctx.prefix);
  const { doc } = createDynamoClients();
  const storage = new DynamoPlaneStorage(doc, { ...names, sessions: `${names.sessions}-missing` });
  const state = createControlPlaneState({
    storage,
    shardCount: 1,
    now: () => NOW,
    blackboardReporting: createBlackboardReporting(config()),
  });
  await expect(repairBlackboardReporting(state)).rejects.toMatchObject({
    name: "ResourceNotFoundException",
  });
  const retained = await doc.send(
    new GetCommand({
      TableName: names.reportingRepairCheckpoints,
      Key: { status: "completed" },
      ConsistentRead: true,
    }),
  );
  expect(retained.Item).toMatchObject({ status: "completed", revision: 1 });
  expect(retained.Item?.cursor).toBeUndefined();
});

it("does not report a stale terminal index result after its authoritative session has resumed", async () => {
  const prior = terminal();
  const { doc } = createDynamoClients();
  class ResumedDuringRepair extends DynamoPlaneStorage {
    override async listSessionsPage(...args: Parameters<DynamoPlaneStorage["listSessionsPage"]>) {
      const indexed = await super.listSessionsPage(...args);
      if (indexed.items.some((item) => item.id === prior.id)) {
        await this.putSession({
          ...prior,
          status: "queued",
          completedAt: undefined,
          result: undefined,
        });
      }
      return indexed;
    }
  }
  const storage = new ResumedDuringRepair(doc, tableNames(ctx.prefix));
  await storage.putSession(prior);
  const state = createControlPlaneState({
    storage,
    shardCount: 1,
    now: () => NOW,
    blackboardReporting: createBlackboardReporting(config()),
  });
  await repairBlackboardReporting(state);
  expect((await storage.getSession(prior.id, true))?.status).toBe("queued");
  expect(await storage.getWebhookDelivery(reportingDelivery(prior)!.id)).toBeNull();
});
