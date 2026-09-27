import { describe, expect, it } from "vitest";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";
import { createDynamoClients, tableNames } from "./dynamo.ts";
import { createWebhookDelivery } from "../../src/webhook-outbox.ts";
import {
  createBlackboardReporting,
  reportingPolicyFields,
  reportingDelivery,
} from "../../src/blackboard-reporting.ts";
import { createControlPlaneState } from "../../src/control-plane-state.ts";
import { repairBlackboardReporting } from "../../src/blackboard-repair.ts";
import type { SessionRecord } from "./types.ts";

const ctx = createDynamoTestCtx("BbReport");
const NOW = "2026-09-27T20:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const config = {
  schemaVersion: 1 as const,
  version: 1,
  url: "https://blackboard.example.test",
  token: "writer-fixture",
  policies: [{ repositoryId: "repo", repository: "owner/repo", principalIds: ["system"] }],
};
const reporting = createBlackboardReporting(config);
function terminal(id: string): SessionRecord {
  return {
    id,
    repositoryId: "repo",
    principalId: "system",
    ...reportingPolicyFields(reporting, "repo", "system"),
    prompt: "private",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: NOW,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "failed",
    queueShard: 0,
    createdAt: NOW,
    completedAt: NOW,
  };
}
function blackboardInput(id: string) {
  const row = terminal(id);
  const delivery = reportingDelivery(row)!;
  return {
    sessionId: row.id,
    repositoryId: row.repositoryId,
    attemptId: row.attemptId ?? null,
    status: row.status,
    occurredAt: row.completedAt!,
    destination: delivery.destination,
    maxAttempts: 2,
    feedback: reporting.snapshot(row, delivery.event.id),
  };
}

describe("durable mandatory reporting", () => {
  it("isolates more than a page of Blackboard rows from retained ordinary pending and expired leases", async () => {
    expect(ctx.storage).not.toBeNull();
    const storage = ctx.storage!;
    const { doc } = createDynamoClients();
    const names = tableNames(ctx.prefix);
    const ordinary = createWebhookDelivery({
      sessionId: "ordinary",
      repositoryId: "repo",
      attemptId: null,
      status: "completed",
      occurredAt: later(1),
      destination: { configurationId: "ordinary", configurationVersion: 1 },
    });
    const retained = ordinary;
    const leased = {
      ...retained,
      id: `${ordinary.id}-leased`,
      state: "leased",
      dueAt: later(1),
      leaseOwner: "old",
      leaseId: "old",
      leaseExpiresAt: later(1),
      attemptCount: 1,
    };
    await doc.send(new PutCommand({ TableName: names.webhookDeliveries, Item: retained }));
    await doc.send(new PutCommand({ TableName: names.webhookDeliveries, Item: leased }));
    for (let i = 0; i < 30; i += 1)
      await storage.enqueueWebhookDelivery(blackboardInput(`bb-${i}`));
    expect(
      await storage.listDueWebhookDeliveries({ state: "pending", now: later(2), limit: 1 }),
    ).toEqual([retained]);
    expect(
      await storage.listDueWebhookDeliveries({ state: "leased", now: later(2), limit: 1 }),
    ).toEqual([leased]);
    expect(
      await storage.listDueWebhookDeliveries({
        lane: "blackboard",
        state: "pending",
        now: later(2),
        limit: 25,
      }),
    ).toHaveLength(25);
    const fence = {
      id: ordinary.id,
      owner: "ordinary-worker",
      leaseId: "new",
      now: later(2),
      leaseExpiresAt: later(3),
    };
    expect((await storage.claimWebhookDelivery(fence))?.event).toEqual(ordinary.event);
    expect(await storage.completeWebhookDelivery(fence)).toBe(true);
    expect((await storage.getWebhookDelivery(ordinary.id))?.id).toBe(ordinary.id);
  });
  it("retries beyond the ordinary ceiling and fences stale Blackboard leases", async () => {
    const storage = ctx.storage!;
    const enqueued = await storage.enqueueWebhookDelivery(blackboardInput("indefinite"));
    for (let i = 0; i < 12; i += 1) {
      const fence = {
        id: enqueued.delivery.id,
        owner: "controller",
        leaseId: `lease-${i}`,
        now: later(i * 2),
        leaseExpiresAt: later(i * 2 + 1),
      };
      expect((await storage.claimWebhookDelivery(fence))?.attemptCount).toBe(i + 1);
      expect(await storage.completeWebhookDelivery({ ...fence, leaseId: "stale" })).toBe(false);
      expect(
        await storage.failWebhookDelivery({
          ...fence,
          nextAttemptAt: later(i * 2 + 2),
          failureCode: "transient-failure",
        }),
      ).toBe("pending");
    }
    expect((await storage.getWebhookDelivery(enqueued.delivery.id))?.feedback).toEqual(
      enqueued.delivery.feedback,
    );
    expect(
      await storage.deadLetterExhaustedWebhookDelivery({
        id: enqueued.delivery.id,
        now: later(25),
      }),
    ).toBe(false);
  });
  it("leases repair checkpoints, restarts malformed cursors, and repairs retained terminal records without a stream", async () => {
    const storage = ctx.storage!;
    const first = (await storage.claimReportingRepair("completed", "one", NOW))!;
    expect(await storage.claimReportingRepair("completed", "two", NOW)).toBeNull();
    expect(await storage.completeReportingRepair({ ...first, owner: "stale" }, null, NOW)).toBe(
      false,
    );
    expect(await storage.completeReportingRepair(first, null, NOW)).toBe(true);
    const { doc } = createDynamoClients();
    const names = tableNames(ctx.prefix);
    await doc.send(
      new UpdateCommand({
        TableName: names.reportingRepairCheckpoints,
        Key: { status: "completed" },
        UpdateExpression: "SET #cursor = :cursor",
        ExpressionAttributeNames: { "#cursor": "cursor" },
        ExpressionAttributeValues: { ":cursor": ["malformed"] },
      }),
    );
    const restarted = (await storage.claimReportingRepair("completed", "three", NOW))!;
    expect(restarted.cursor).toBeNull();
    expect(restarted.revision).toBeGreaterThan(first.revision);
    expect(await storage.completeReportingRepair(restarted, null, NOW)).toBe(true);
    const row = terminal("retained-no-stream");
    await storage.putSession(row);
    const state = createControlPlaneState({
      storage,
      blackboardReporting: reporting,
      shardCount: 1,
      now: () => NOW,
    });
    await repairBlackboardReporting(state);
    const saved = await storage.getWebhookDelivery(reportingDelivery(row)!.id);
    expect(saved?.feedback?.envelope.workOutcome).toBe("failure");
    await repairBlackboardReporting(state, () => false);
    expect(await storage.getWebhookDelivery(saved!.id)).toEqual(saved);
  });
});
