/* eslint-disable max-lines -- Slack lifecycle cases share one in-memory outbox. */
import { describe, expect, it, vi } from "vitest";

import type {
  SlackDeliveryRecord,
  SlackOutboxStore,
  SlackTransport,
} from "./slack-delivery-types.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";
import { SlackLifecycleWorker } from "./slack-worker.ts";

const initial = "2026-08-12T10:00:00.000Z";

class MemoryOutbox implements SlackOutboxStore {
  readonly items = new Map<string, SlackDeliveryRecord>();

  async enqueue(record: SlackDeliveryRecord) {
    if (this.items.has(record.id)) return "exists" as const;
    this.items.set(record.id, structuredClone(record));
    return "created" as const;
  }

  async claimDue(input: Parameters<SlackOutboxStore["claimDue"]>[0]) {
    const record = [...this.items.values()].find(
      ({ status, nextAttemptAt }) =>
        (status === "pending" || status === "delivering") && nextAttemptAt <= input.now,
    );
    if (!record) return null;
    Object.assign(record, {
      status: "delivering",
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      nextAttemptAt: input.leaseExpiresAt,
    });
    return structuredClone(record);
  }

  async get(id: string) {
    return structuredClone(this.items.get(id) ?? null);
  }

  async complete(input: Parameters<SlackOutboxStore["complete"]>[0]) {
    const record = this.items.get(input.id);
    if (!record || record.leaseToken !== input.leaseToken) return false;
    Object.assign(record, {
      status: "sent",
      remoteChannel: input.result.channel,
      remoteMessageTs: input.result.messageTs,
    });
    return true;
  }

  async reschedule(input: Parameters<SlackOutboxStore["reschedule"]>[0]) {
    const record = this.items.get(input.id);
    if (!record || record.leaseToken !== input.leaseToken) return false;
    Object.assign(record, input, { lastError: input.error });
    delete record.leaseToken;
    delete record.leaseExpiresAt;
    return true;
  }
}

const config = {
  enabled: true,
  defaultChannel: "C123",
  notifications: DEFAULT_SLACK_NOTIFICATIONS,
};

const completed = {
  id: "session-1",
  repositoryName: "auto-harness",
  prompt: "ship it",
  commandLabel: "Codex",
  priority: 4,
  source: "ui",
  url: "https://example.test/sessions/session-1",
  status: "completed" as const,
  createdAt: initial,
  startedAt: initial,
  completedAt: initial,
  exitCode: 0,
};

describe("Slack lifecycle worker", () => {
  it("reconciles and drains an ordered lifecycle through a synthetic transport", async () => {
    const store = new MemoryOutbox();
    const requests: Parameters<SlackTransport["deliver"]>[0][] = [];
    const transport: SlackTransport = {
      async deliver(request) {
        requests.push(request);
        return { channel: request.channel, messageTs: `ts-${request.idempotencyKey}` };
      },
    };
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport,
        getConfig: async () => config,
        listSessions: async () => [completed],
      },
      { now: () => initial },
    );
    worker.start();
    await worker.stop();

    expect(requests.map(({ operation }) => operation)).toEqual([
      "post-root",
      "post-reply",
      "post-reply",
      "update-root",
    ]);
    expect(requests[1]).toMatchObject({ threadTs: "ts-slack:session-1:thread" });
    expect(requests[3]).toMatchObject({ messageTs: "ts-slack:session-1:thread" });

    const restarted = new SlackLifecycleWorker({
      store,
      transport,
      getConfig: async () => config,
      listSessions: async () => [completed],
    });
    restarted.start();
    await restarted.stop();
    expect(requests).toHaveLength(4);
  });

  it("recovers retry and dependency deferrals on a later synthetic tick", async () => {
    const store = new MemoryOutbox();
    let clock = initial;
    const deliver = vi
      .fn<SlackTransport["deliver"]>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockImplementation(async (request) => ({
        channel: request.channel,
        messageTs: `ts-${request.idempotencyKey}`,
      }));
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver },
        getConfig: async () => config,
        listSessions: async () => [completed],
      },
      { now: () => clock, maxOperationsPerTick: 20 },
    );
    worker.start();
    await worker.stop();
    expect(store.items.get("slack:session-1:thread")).toMatchObject({
      status: "pending",
      attempts: 1,
    });

    clock = "2026-08-12T10:01:00.000Z";
    const restarted = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver },
        getConfig: async () => config,
        listSessions: async () => [completed],
      },
      { now: () => clock },
    );
    restarted.start();
    await restarted.stop();
    expect([...store.items.values()].every(({ status }) => status === "sent")).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(5);
  });

  it("guards lifecycle, configuration, validation, and error boundaries", async () => {
    expect(() => new SlackLifecycleWorker({} as never, { intervalMs: 0 })).toThrow(RangeError);
    expect(() => new SlackLifecycleWorker({} as never, { maxOperationsPerTick: 0 })).toThrow(
      RangeError,
    );
    const onError = vi.fn(() => {
      throw new Error("observer");
    });
    const worker = new SlackLifecycleWorker(
      {
        store: new MemoryOutbox(),
        transport: { deliver: vi.fn() },
        getConfig: vi
          .fn()
          .mockRejectedValueOnce(new Error("config unavailable"))
          .mockResolvedValue(null),
        listSessions: vi.fn(),
      },
      { onError },
    );
    await expect(worker.tick()).resolves.toBe(false);
    worker.start();
    worker.start();
    await expect(worker.tick()).resolves.toBe(false);
    await worker.stop();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("handles disabled configuration, bounded work, and a superseded tick marker", async () => {
    const disabled = new SlackLifecycleWorker({
      store: new MemoryOutbox(),
      transport: { deliver: vi.fn() },
      getConfig: async () => ({ ...config, enabled: false }),
      listSessions: vi.fn(),
    });
    disabled.start();
    await disabled.stop();

    const store = new MemoryOutbox();
    const bounded = new SlackLifecycleWorker(
      {
        store,
        transport: {
          deliver: async (request) => ({ channel: request.channel, messageTs: "message" }),
        },
        getConfig: async () => config,
        listSessions: async () => [completed],
      },
      { maxOperationsPerTick: 1, now: () => initial },
    );
    bounded.start();
    const pending = (bounded as unknown as { inFlight: Promise<void> }).inFlight;
    (bounded as unknown as { inFlight: Promise<void> }).inFlight = Promise.resolve();
    await pending;
    await bounded.stop();
  });
});
