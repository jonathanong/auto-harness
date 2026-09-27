import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";
import {
  createBlackboardReporting,
  reportingDelivery,
  reportingPolicyFields,
} from "../blackboard-reporting.ts";
import { repairBlackboardReporting } from "../blackboard-repair.ts";
import { createControlPlaneState } from "../control-plane-state.ts";
import type { WebhookEnqueueInput } from "../webhook-outbox.ts";
import { createDynamoClients, tableNames } from "./dynamo.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";
import { enqueueWebhookDelivery } from "./plane-storage-webhook-outbox.ts";
import type { ReportingRepairCheckpoint } from "./plane-storage-reporting-repair.ts";
import type { SessionRecord } from "./types.ts";

const ctx = createDynamoTestCtx("BbRepair");
const NOW = "2026-09-27T20:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
const reporting = createBlackboardReporting({
  schemaVersion: 1,
  version: 1,
  url: "https://blackboard.example.test",
  token: "writer-fixture",
  policies: [{ repositoryId: "repo", repository: "owner/repo", principalIds: ["system"] }],
});

beforeEach(async () => {
  expect(ctx.storage, "DynamoDB Local must actually be available").not.toBeNull();
  await ctx.storage!.clearAll();
});

function terminal(index: number): SessionRecord {
  return {
    id: `retained-${String(index).padStart(3, "0")}`,
    repositoryId: "repo",
    principalId: "system",
    ...reportingPolicyFields(reporting, "repo", "system"),
    prompt: "private retained prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: at(60),
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: at(index),
    completedAt: at(index + 30),
  };
}
async function seed(count: number) {
  const rows = Array.from({ length: count }, (_, index) => terminal(index));
  for (const row of rows) await ctx.storage!.putSession(row);
  return rows;
}
function state(storage = ctx.storage!, now: () => string = () => at(200), shardCount = 1) {
  return createControlPlaneState({ storage, blackboardReporting: reporting, shardCount, now });
}
async function checkpoint() {
  const { doc } = createDynamoClients();
  const response = await doc.send(
    new GetCommand({
      TableName: tableNames(ctx.prefix).reportingRepairCheckpoints,
      Key: { status: "completed" },
      ConsistentRead: true,
    }),
  );
  return response.Item!;
}
async function deliveries() {
  return ctx.storage!.listDueWebhookDeliveries({
    lane: "blackboard",
    state: "pending",
    now: at(300),
    limit: 100,
  });
}

/** Faults still cross the real DynamoDB boundary; no mocked provider response or storage implementation. */
class InterruptedStorage extends DynamoPlaneStorage {
  committed = 0;
  failAfter?: number;
  afterCommit?: () => Promise<void>;
  override async enqueueWebhookDelivery(input: WebhookEnqueueInput) {
    if (this.failAfter !== undefined && this.committed >= this.failAfter) {
      return enqueueWebhookDelivery(
        {
          ...this.ctx,
          tables: {
            ...this.ctx.tables,
            webhookDeliveries: `${this.ctx.tables.webhookDeliveries}-unavailable`,
          },
        },
        input,
      );
    }
    const result = await super.enqueueWebhookDelivery(input);
    this.committed += 1;
    await this.afterCommit?.();
    return result;
  }
}
function interrupted() {
  return new InterruptedStorage(createDynamoClients().doc, tableNames(ctx.prefix));
}

describe("real DynamoDB Blackboard reporting repair", () => {
  it("persists only one indexed page per tick, then continues beyond twenty retained terminal rows", async () => {
    const rows = await seed(25);
    const current = state();
    await repairBlackboardReporting(current);
    const first = await deliveries();
    expect(first).toHaveLength(20);
    expect(first.map((delivery) => delivery.event.subject.id).toSorted()).toEqual(
      rows.slice(0, 20).map((row) => row.id),
    );
    const saved = await checkpoint();
    expect(saved.cursor).toHaveLength(1);
    expect(saved.cursor[0].checkpoint.id).toBe(rows[19]!.id);
    expect(saved.leaseOwner).toBeUndefined();
    await repairBlackboardReporting(current);
    expect(await deliveries()).toHaveLength(25);
    expect((await checkpoint()).cursor).toBeNull();
    await repairBlackboardReporting(current);
    expect(await deliveries()).toHaveLength(25);
    for (const original of first)
      expect(await ctx.storage!.getWebhookDelivery(original.id)).toEqual(original);
  });

  it("retains a partially persisted page until the failed lease expires, then replays identical evidence", async () => {
    const rows = await seed(3);
    const storage = interrupted();
    storage.failAfter = 1;
    let now = at(200);
    await expect(repairBlackboardReporting(state(storage, () => now))).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
    const first = await ctx.storage!.getWebhookDelivery(reportingDelivery(rows[0]!)!.id);
    expect(first?.feedback?.envelope.workOutcome).toBe("success");
    expect(await deliveries()).toHaveLength(1);
    const failed = await checkpoint();
    expect(failed.cursor).toBeUndefined();
    expect(failed.leaseUntil).toBe(at(260));
    now = at(259);
    await repairBlackboardReporting(state(ctx.storage!, () => now));
    expect(await deliveries()).toHaveLength(1);
    now = at(261);
    await repairBlackboardReporting(state(ctx.storage!, () => now));
    expect(await deliveries()).toHaveLength(3);
    expect(await ctx.storage!.getWebhookDelivery(first!.id)).toEqual(first);
    expect((await checkpoint()).cursor).toBeNull();
  });

  it("fences a worker that loses its repair lease mid-page and safely repeats its committed events", async () => {
    await seed(4);
    const storage = interrupted();
    let now = at(200);
    let replacement: ReportingRepairCheckpoint | null = null;
    storage.afterCommit = async () => {
      if (storage.committed !== 1) return;
      now = at(261);
      replacement = await ctx.storage!.claimReportingRepair("completed", "replacement", now);
      expect(replacement).not.toBeNull();
    };
    await repairBlackboardReporting(state(storage, () => now));
    const originals = await deliveries();
    expect(originals).toHaveLength(4);
    const lost = await checkpoint();
    expect(lost.leaseOwner).toBe("replacement");
    expect(lost.cursor).toBeUndefined();
    expect(
      await ctx.storage!.completeReportingRepair(
        { ...replacement!, owner: "expired-worker" },
        null,
        now,
      ),
    ).toBe(false);
    now = at(322);
    await repairBlackboardReporting(state(ctx.storage!, () => now));
    expect((await checkpoint()).cursor).toBeNull();
    expect(await deliveries()).toEqual(originals);
  });

  it("restarts an incompatible shard cursor and eventually delivers every retained event without replacing snapshots", async () => {
    await seed(25);
    await repairBlackboardReporting(state());
    expect((await checkpoint()).cursor).toHaveLength(1);
    const originals = await deliveries();
    const changed = state(ctx.storage!, () => at(200), 2);
    await repairBlackboardReporting(changed);
    expect((await checkpoint()).cursor).toHaveLength(2);
    expect(await deliveries()).toEqual(originals);
    await repairBlackboardReporting(changed);
    expect(await deliveries()).toHaveLength(25);
    expect((await checkpoint()).cursor).toBeNull();
    for (const original of originals)
      expect(await ctx.storage!.getWebhookDelivery(original.id)).toEqual(original);
  });
});
