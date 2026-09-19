/* eslint-disable max-lines -- Slack lifecycle cases share one in-memory outbox. */
import { describe, expect, it, vi } from "vitest";

import type {
  SlackDeliveryRecord,
  SlackOutboxStore,
  SlackTransport,
} from "./slack-delivery-types.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type SlackDeliveryOutcome,
} from "./slack-integration-types.ts";
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
  installationId: "installation-1",
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
    const onError = vi.fn();
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
      { now: () => clock, maxOperationsPerTick: 20, onError },
    );
    worker.start();
    await worker.stop();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("retried") }),
    );
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
    expect(() => new SlackLifecycleWorker({} as never, { outcomeFlushTimeoutMs: 0 })).toThrow(
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
    const getDisabledConfig = vi.fn(async () => ({ ...config, enabled: false }));
    const disabled = new SlackLifecycleWorker({
      store: new MemoryOutbox(),
      transport: { deliver: vi.fn() },
      getConfig: getDisabledConfig,
      listSessions: vi.fn(),
    });
    disabled.start();
    await disabled.stop();
    expect(getDisabledConfig).toHaveBeenCalledOnce();
    await expect(
      new SlackLifecycleWorker({
        store: new MemoryOutbox(),
        transport: { deliver: vi.fn() },
        getConfig: async () => ({ ...config, enabled: false }),
        listSessions: vi.fn(),
      }).stop(),
    ).resolves.toBeUndefined();

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
    expect([...store.items.values()].filter(({ status }) => status === "sent")).toHaveLength(1);
  });

  it("reports delivery outcomes for Settings without letting a throwing reporter block draining", async () => {
    const store = new MemoryOutbox();
    let clock = initial;
    const outcomes: SlackDeliveryOutcome[] = [];
    const recordDeliveryOutcome = async (outcome: SlackDeliveryOutcome) => {
      outcomes.push(outcome);
      // Delivery-status observability failing must never affect the outbox itself.
      throw new Error("observability boom");
    };
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
        recordDeliveryOutcome,
      },
      { now: () => clock, maxOperationsPerTick: 20 },
    );
    worker.start();
    await worker.stop();
    expect(outcomes).toEqual([
      {
        ok: false,
        error: expect.stringContaining("temporary"),
        at: initial,
        installationId: "installation-1",
      },
    ]);

    clock = "2026-08-12T10:01:00.000Z";
    const restarted = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver },
        getConfig: async () => config,
        listSessions: async () => [completed],
        recordDeliveryOutcome,
      },
      { now: () => clock },
    );
    restarted.start();
    await restarted.stop();

    expect(outcomes.filter((outcome) => outcome.ok)).toEqual([
      { ok: true, at: clock, installationId: "installation-1" },
    ]);
    expect([...store.items.values()].every(({ status }) => status === "sent")).toBe(true);
  });

  it("reports the claimed row's installation rather than the currently loaded installation", async () => {
    const store = new MemoryOutbox();
    store.items.set("stale-delivery", {
      id: "stale-delivery",
      integrationId: "slack",
      installationId: "installation-a",
      sessionId: "session-from-a",
      event: "session_created",
      operation: "post-root",
      channel: "C123",
      text: "stale",
      status: "pending",
      attempts: 0,
      maxAttempts: 8,
      nextAttemptAt: initial,
      createdAt: initial,
      updatedAt: initial,
    });
    const recordDeliveryOutcome = vi.fn(async () => undefined);
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver: vi.fn().mockRejectedValue(new Error("old delivery failed")) },
        getConfig: async () => ({ ...config, installationId: "installation-b" }),
        listSessions: async () => [],
        recordDeliveryOutcome,
      },
      { now: () => initial, maxOperationsPerTick: 1 },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(recordDeliveryOutcome).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining("old delivery failed"),
      at: initial,
      installationId: "installation-a",
    });
  });

  it("retains one latest outcome per installation in a mixed-identity drain", async () => {
    const store = new MemoryOutbox();
    const delivery = (id: string, installationId: string): SlackDeliveryRecord => ({
      id,
      integrationId: "slack",
      installationId,
      sessionId: id,
      event: "session_created",
      operation: "post-root",
      channel: "C123",
      text: id,
      status: "pending",
      attempts: 0,
      maxAttempts: 8,
      nextAttemptAt: initial,
      createdAt: initial,
      updatedAt: initial,
    });
    store.items.set("current-b", delivery("current-b", "installation-b"));
    store.items.set("stale-a", delivery("stale-a", "installation-a"));
    const recordDeliveryOutcome = vi.fn(async () => undefined);
    const deliver = vi
      .fn<SlackTransport["deliver"]>()
      .mockRejectedValueOnce(new Error("current delivery failed"))
      .mockImplementation(async (request) => ({
        channel: request.channel,
        messageTs: `ts-${request.idempotencyKey}`,
      }));
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver },
        getConfig: async () => ({ ...config, installationId: "installation-b" }),
        listSessions: async () => [],
        recordDeliveryOutcome,
      },
      { now: () => initial, maxOperationsPerTick: 2 },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(recordDeliveryOutcome).toHaveBeenCalledTimes(2);
    expect(recordDeliveryOutcome).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining("current delivery failed"),
      at: initial,
      installationId: "installation-b",
    });
    expect(recordDeliveryOutcome).toHaveBeenCalledWith({
      ok: true,
      at: initial,
      installationId: "installation-a",
    });
  });

  it("runs a one-shot drain without starting the interval timer", async () => {
    const store = new MemoryOutbox();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async (request: { channel: string; idempotencyKey: string }) => {
      await blocked;
      return { channel: request.channel, messageTs: `ts-${request.idempotencyKey}` };
    });
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver },
        getConfig: async () => config,
        listSessions: async () => [completed],
      },
      { now: () => initial },
    );
    const first = worker.runOnce();
    expect(await worker.runOnce()).toBe(false);
    expect(await worker.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(deliver).toHaveBeenCalled();
  });

  it("waits for delivery outcome persistence before a one-shot drain returns", async () => {
    const store = new MemoryOutbox();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordDeliveryOutcome = vi.fn(async () => blocked);
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport: {
          deliver: async (request) => ({
            channel: request.channel,
            messageTs: `ts-${request.idempotencyKey}`,
          }),
        },
        getConfig: async () => config,
        listSessions: async () => [completed],
        recordDeliveryOutcome,
      },
      { now: () => initial },
    );
    const run = worker.runOnce();
    await vi.waitFor(() => expect(recordDeliveryOutcome).toHaveBeenCalledOnce());
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(run).resolves.toBe(true);
  });

  it("bounds and coalesces delivery outcome persistence after draining the tick", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryOutbox();
      const recordDeliveryOutcome = vi.fn(async () => new Promise<void>(() => undefined));
      const deliver = vi.fn(async (request: { channel: string; idempotencyKey: string }) => ({
        channel: request.channel,
        messageTs: `ts-${request.idempotencyKey}`,
      }));
      const onError = vi.fn();
      const worker = new SlackLifecycleWorker(
        {
          store,
          transport: { deliver },
          getConfig: async () => config,
          listSessions: async () => [completed],
          recordDeliveryOutcome,
        },
        { now: () => initial, outcomeFlushTimeoutMs: 5, onError },
      );

      const run = worker.runOnce();
      await vi.waitFor(() => expect(recordDeliveryOutcome).toHaveBeenCalledOnce());
      expect(deliver).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(5);

      await expect(run).resolves.toBe(true);
      expect(recordDeliveryOutcome).toHaveBeenCalledWith({
        ok: true,
        at: initial,
        installationId: "installation-1",
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Slack delivery outcome persistence timed out" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
