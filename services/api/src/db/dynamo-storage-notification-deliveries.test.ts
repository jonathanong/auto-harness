import { describe, expect, it } from "vitest";

import type { SlackDeliveryRecord, SlackOutboxStore } from "../slack-delivery-types.ts";
import { createDynamoClients, tableNames } from "./dynamo.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";

const dynamo = createDynamoTestCtx("SlackOutbox");
const createdAt = "2026-08-12T10:00:00.000Z";

function delivery(id: string): SlackDeliveryRecord {
  return {
    id,
    integrationId: "slack",
    sessionId: "session-1",
    event: "session_created",
    operation: "post-root",
    channel: "C123",
    text: "queued",
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

async function claimEventually(
  store: SlackOutboxStore,
  input: Parameters<SlackOutboxStore["claimDue"]>[0],
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claimed = await store.claimDue(input);
    if (claimed) return claimed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

describe("Dynamo Slack delivery outbox", () => {
  it("persists insert-only records and fences competing or stale leases", async () => {
    if (!dynamo.storage) return;
    const store = dynamo.storage!;
    expect(await store.enqueue(delivery("delivery-1"))).toBe("created");
    expect(await store.enqueue(delivery("delivery-1"))).toBe("exists");

    const first = await claimEventually(store, {
      now: createdAt,
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-08-12T10:00:30.000Z",
    });
    expect(first).toMatchObject({ status: "delivering", leaseToken: "lease-1" });
    expect(
      await store.complete({
        id: "delivery-1",
        leaseToken: "wrong",
        result: { channel: "C123", messageTs: "1.0" },
        now: createdAt,
      }),
    ).toBe(false);

    const reclaimed = await claimEventually(store, {
      now: "2026-08-12T10:00:31.000Z",
      leaseToken: "lease-2",
      leaseExpiresAt: "2026-08-12T10:01:01.000Z",
    });
    expect(reclaimed).toMatchObject({ id: "delivery-1", leaseToken: "lease-2" });
    expect(
      await store.reschedule({
        id: "delivery-1",
        leaseToken: "wrong",
        status: "pending",
        attempts: 1,
        nextAttemptAt: createdAt,
        error: "retry",
        now: createdAt,
      }),
    ).toBe(false);
    expect(
      await store.reschedule({
        id: "delivery-1",
        leaseToken: "lease-2",
        status: "pending",
        attempts: 1,
        nextAttemptAt: createdAt,
        error: "retry",
        now: createdAt,
      }),
    ).toBe(true);
  });

  it("survives a storage restart and retains remote thread metadata", async () => {
    if (!dynamo.storage) return;
    const { doc } = createDynamoClients();
    const restarted = new DynamoPlaneStorage(doc, tableNames(dynamo.prefix));
    const claimed = await claimEventually(restarted, {
      now: createdAt,
      leaseToken: "lease-3",
      leaseExpiresAt: "2026-08-12T10:00:30.000Z",
    });
    expect(claimed).toMatchObject({ id: "delivery-1", attempts: 1 });
    expect(
      await restarted.complete({
        id: "delivery-1",
        leaseToken: "lease-3",
        result: { channel: "C999", messageTs: "123.456" },
        now: createdAt,
      }),
    ).toBe(true);
    expect(await restarted.get("delivery-1")).toMatchObject({
      status: "sent",
      remoteChannel: "C999",
      remoteMessageTs: "123.456",
    });
    expect(await restarted.get("missing")).toBeNull();
    expect(
      await restarted.claimDue({ now: createdAt, leaseToken: "x", leaseExpiresAt: createdAt }),
    ).toBeNull();
  });
});
