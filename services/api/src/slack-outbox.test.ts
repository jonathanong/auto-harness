/* eslint-disable max-lines -- durable lease, retry, and idempotency cases share one store harness. */
import { describe, expect, it, vi } from "vitest";

import type {
  SlackDeliveryRecord,
  SlackOutboxStore,
  SlackTransport,
} from "./slack-delivery-types.ts";
import { enqueueSlackDeliveries, processSlackOutboxOnce, retryDelay } from "./slack-outbox.ts";

const now = "2026-08-12T10:00:00.000Z";

function record(
  id: string,
  operation: SlackDeliveryRecord["operation"] = "post-root",
): SlackDeliveryRecord {
  return {
    id,
    integrationId: "slack",
    sessionId: "session-1",
    event: operation === "post-root" ? "session_created" : "session_completed",
    operation,
    channel: "C123",
    text: id,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

class MemoryStore implements SlackOutboxStore {
  readonly items = new Map<string, SlackDeliveryRecord>();
  loseComplete = false;

  async enqueue(value: SlackDeliveryRecord) {
    if (this.items.has(value.id)) return "exists" as const;
    this.items.set(value.id, structuredClone(value));
    return "created" as const;
  }

  async claimDue(input: Parameters<SlackOutboxStore["claimDue"]>[0]) {
    const value = [...this.items.values()].find(
      (item) =>
        (item.status === "pending" || item.status === "delivering") &&
        item.nextAttemptAt <= input.now,
    );
    if (!value) return null;
    Object.assign(value, {
      status: "delivering",
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      nextAttemptAt: input.leaseExpiresAt,
    });
    return structuredClone(value);
  }

  async get(id: string) {
    return structuredClone(this.items.get(id) ?? null);
  }

  async complete(input: Parameters<SlackOutboxStore["complete"]>[0]) {
    if (this.loseComplete) return false;
    const value = this.items.get(input.id);
    if (!value || value.leaseToken !== input.leaseToken) return false;
    Object.assign(value, {
      status: "sent",
      remoteChannel: input.result.channel,
      remoteMessageTs: input.result.messageTs,
    });
    return true;
  }

  async reschedule(input: Parameters<SlackOutboxStore["reschedule"]>[0]) {
    const value = this.items.get(input.id);
    if (!value || value.leaseToken !== input.leaseToken) return false;
    Object.assign(value, input, {
      lastError: input.error,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return true;
  }
}

describe("Slack durable outbox", () => {
  it("uses runtime clock and lease-token defaults when options are omitted", async () => {
    const store = new MemoryStore();
    await store.enqueue(record("root-defaults"));
    const deliver = vi.fn().mockResolvedValue({ channel: "C123", messageTs: "ts-defaults" });

    expect(await processSlackOutboxOnce(store, { deliver })).toBe("sent");
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "root-defaults", channel: "C123" }),
    );
  });

  it("enqueues stable IDs idempotently and delivers an ordered thread", async () => {
    const store = new MemoryStore();
    const root = record("root");
    const reply = {
      ...record("reply", "post-reply"),
      threadRootId: root.id,
      dependsOnId: root.id,
    };
    const update = {
      ...record("update", "update-root"),
      threadRootId: root.id,
      dependsOnId: reply.id,
    };
    expect(await enqueueSlackDeliveries(store, [root, reply, update])).toEqual({
      created: 3,
      existing: 0,
    });
    expect(await enqueueSlackDeliveries(store, [root, reply, update])).toEqual({
      created: 0,
      existing: 3,
    });

    const requests: Parameters<SlackTransport["deliver"]>[0][] = [];
    const transport: SlackTransport = {
      async deliver(request) {
        requests.push(request);
        return { channel: request.channel, messageTs: `ts-${request.idempotencyKey}` };
      },
    };
    const options = { now: () => now, leaseToken: () => `lease-${requests.length}` };
    expect(await processSlackOutboxOnce(store, transport, options)).toBe("sent");
    expect(await processSlackOutboxOnce(store, transport, options)).toBe("sent");
    expect(await processSlackOutboxOnce(store, transport, options)).toBe("sent");
    expect(await processSlackOutboxOnce(store, transport, options)).toBe("idle");
    expect(requests).toMatchObject([
      { idempotencyKey: "root", operation: "post-root", channel: "C123" },
      { idempotencyKey: "reply", operation: "post-reply", threadTs: "ts-root" },
      { idempotencyKey: "update", operation: "update-root", messageTs: "ts-root" },
    ]);
  });

  it("defers dependencies without consuming a retry", async () => {
    const store = new MemoryStore();
    await store.enqueue({
      ...record("reply", "post-reply"),
      dependsOnId: "missing",
      threadRootId: "missing",
    });
    const transport = { deliver: vi.fn() };
    expect(
      await processSlackOutboxOnce(store, transport, {
        now: () => now,
        leaseToken: () => "lease",
        dependencyDelayMs: 5,
      }),
    ).toBe("deferred");
    expect(store.items.get("reply")).toMatchObject({ attempts: 0, status: "pending" });
    expect(transport.deliver).not.toHaveBeenCalled();

    const incompleteRoot = record("root");
    Object.assign(incompleteRoot, { status: "sent", remoteMessageTs: "ts-root" });
    store.items.set("root", incompleteRoot);
    store.items.set("reply", {
      ...record("reply", "post-reply"),
      threadRootId: "root",
    });
    expect(
      await processSlackOutboxOnce(store, transport, {
        now: () => now,
        leaseToken: () => "lease-2",
      }),
    ).toBe("deferred");
  });

  it("dead-letters operations whose dependency cannot be delivered", async () => {
    const store = new MemoryStore();
    const deadRoot = { ...record("root"), status: "dead" as const };
    store.items.set(deadRoot.id, deadRoot);
    store.items.set("reply", {
      ...record("reply", "post-reply"),
      dependsOnId: deadRoot.id,
      threadRootId: deadRoot.id,
    });
    expect(
      await processSlackOutboxOnce(
        store,
        { deliver: vi.fn() },
        {
          now: () => now,
          leaseToken: () => "lease",
        },
      ),
    ).toBe("dead");
    expect(store.items.get("reply")).toMatchObject({
      status: "dead",
      attempts: 0,
      lastError: "dependency root is dead",
    });

    const sentDependency = {
      ...record("sent"),
      status: "sent" as const,
      remoteChannel: "C123",
      remoteMessageTs: "ts-sent",
    };
    store.items.set(sentDependency.id, sentDependency);
    store.items.set("dead-thread", { ...record("dead-thread"), status: "dead" });
    store.items.set("update", {
      ...record("update", "update-root"),
      dependsOnId: sentDependency.id,
      threadRootId: "dead-thread",
    });
    expect(
      await processSlackOutboxOnce(
        store,
        { deliver: vi.fn() },
        {
          now: () => now,
          leaseToken: () => "lease-2",
        },
      ),
    ).toBe("dead");
    expect(store.items.get("update")?.status).toBe("dead");
  });

  it("retries transport errors and dead-letters at the attempt ceiling", async () => {
    const store = new MemoryStore();
    await store.enqueue({ ...record("root"), maxAttempts: 2 });
    const transport = { deliver: vi.fn().mockRejectedValueOnce(new Error("nope".repeat(200))) };
    expect(
      await processSlackOutboxOnce(store, transport, {
        now: () => now,
        leaseToken: () => "lease-1",
        baseRetryMs: 10,
        maxRetryMs: 15,
      }),
    ).toBe("retried");
    expect(store.items.get("root")?.lastError).toHaveLength(500);
    store.items.get("root")!.nextAttemptAt = now;
    transport.deliver.mockRejectedValueOnce("bad");
    const failures: Array<{ id: string; status: string; error: string }> = [];
    expect(
      await processSlackOutboxOnce(store, transport, {
        now: () => now,
        leaseToken: () => "lease-2",
        onFailure: (event) => failures.push(event),
      }),
    ).toBe("dead");
    expect(failures).toEqual([
      expect.objectContaining({ id: "root", operation: "post-root", status: "dead" }),
    ]);
    expect(JSON.stringify(failures)).not.toContain("xoxb-");
    store.items.get("root")!.status = "pending";
    store.items.get("root")!.nextAttemptAt = now;
    store.items.get("root")!.leaseToken = undefined;
    expect(
      await processSlackOutboxOnce(
        store,
        { deliver: vi.fn().mockRejectedValue("bad") },
        {
          now: () => now,
          leaseToken: () => "lease-3",
          onFailure: () => {
            throw new Error("observer");
          },
        },
      ),
    ).toBe("dead");
    expect(retryDelay(3, 10, 15)).toBe(15);
  });

  it("honors a transport Retry-After delay over exponential backoff", async () => {
    const store = new MemoryStore();
    await store.enqueue(record("root"));
    const error = Object.assign(new Error("rate-limited"), { retryAfterMs: 7_000 });
    expect(
      await processSlackOutboxOnce(
        store,
        { deliver: vi.fn().mockRejectedValue(error) },
        {
          now: () => now,
          leaseToken: () => "lease-retry-after",
          baseRetryMs: 1_000,
          maxRetryMs: 2_000,
        },
      ),
    ).toBe("retried");
    expect(store.items.get("root")?.nextAttemptAt).toBe("2026-08-12T10:00:07.000Z");
  });

  it("lets a loopback transport deduplicate an ambiguous success", async () => {
    const store = new MemoryStore();
    store.loseComplete = true;
    await store.enqueue(record("root"));
    const remote = new Map<string, { channel: string; messageTs: string }>();
    const deliver = vi.fn(async (request: Parameters<SlackTransport["deliver"]>[0]) => {
      const existing = remote.get(request.idempotencyKey);
      if (existing) return existing;
      const created = { channel: request.channel, messageTs: `ts-${remote.size + 1}` };
      remote.set(request.idempotencyKey, created);
      return created;
    });
    expect(
      await processSlackOutboxOnce(
        store,
        { deliver },
        {
          now: () => now,
          leaseToken: () => "lease-1",
        },
      ),
    ).toBe("retried");
    store.loseComplete = false;
    expect(
      await processSlackOutboxOnce(
        store,
        { deliver },
        {
          now: () => "2026-08-12T10:00:02.000Z",
          leaseToken: () => "lease-2",
        },
      ),
    ).toBe("sent");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(remote).toHaveLength(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "root" }));
  });
});
