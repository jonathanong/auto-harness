/* eslint-disable max-lines -- attach, HTTP send, and bounded reconcile cases share one store. */
import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackDeliveryRecord, SlackOutboxStore } from "./slack-delivery-types.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type SlackIntegrationRecord,
} from "./slack-integration-types.ts";
import { createSlackLifecycleWorker } from "./slack-runtime.ts";

const now = "2026-08-12T10:00:00.000Z";
const token = "xoxb-1234567890-abcdefghij";

class MemoryOutbox implements SlackOutboxStore {
  readonly items = new Map<string, SlackDeliveryRecord>();

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
    Object.assign(value, input, { lastError: input.error });
    return true;
  }
}

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (plaintext) => Buffer.from(plaintext, "utf8").toString("base64"),
    decrypt: async (ciphertext) => Buffer.from(ciphertext, "base64").toString("utf8"),
  };
}

function slackRecord(): SlackIntegrationRecord {
  return {
    id: "slack",
    type: "slack",
    encryptedConfig: Buffer.from(JSON.stringify({ botToken: token }), "utf8").toString("base64"),
    defaultChannel: "C123",
    enabled: true,
    notifications: DEFAULT_SLACK_NOTIFICATIONS,
    signingSecretConfigured: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function sessionRecord(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    repositoryId: "repo-1",
    prompt: id,
    target: { commandId: "command-1" },
    fallbacks: [],
    targetLabels: ["Codex"],
    queueTtlSeconds: 60,
    queueExpiresAt: now,
    timeout: 60,
    priority: 4,
    requiredLabels: [],
    status,
    queueShard: 0,
    createdAt: now,
    ...extra,
  } as never;
}

describe("Slack production runtime", () => {
  it("starts only with an outbox and either credentials or an injected transport", () => {
    expect(createSlackLifecycleWorker(new ControlPlane())).toBeUndefined();
    expect(
      createSlackLifecycleWorker(
        new ControlPlane({ storage: { enqueue: async () => "created" } as never }),
      ),
    ).toBeUndefined();
    const store = new MemoryOutbox();
    expect(
      createSlackLifecycleWorker(new ControlPlane({ storage: store as never })),
    ).toBeUndefined();
    expect(
      createSlackLifecycleWorker(new ControlPlane({ storage: store as never }), {
        transport: { deliver: vi.fn() },
      }),
    ).toBeDefined();
    expect(
      createSlackLifecycleWorker(
        new ControlPlane({ storage: store as never, secretEncryptor: encryptor() }),
      ),
    ).toBeDefined();
  });

  it("delivers through the HTTP transport when the bot token can be decrypted", async () => {
    const store = new MemoryOutbox();
    const plane = new ControlPlane({
      storage: Object.assign(store, {
        getSlackIntegration: async () => slackRecord(),
        listAllSessions: async () => [
          {
            id: "session-1",
            repositoryId: "repo-1",
            prompt: "ship it",
            target: { commandId: "command-1" },
            fallbacks: [],
            targetLabels: ["Codex"],
            queueTtlSeconds: 60,
            queueExpiresAt: now,
            timeout: 60,
            priority: 4,
            requiredLabels: [],
            status: "queued",
            queueShard: 0,
            createdAt: now,
          },
        ],
        getRepository: async () => ({
          id: "repo-1",
          name: "auto-harness",
          url: "git@example.test:auto-harness.git",
          defaultBranch: "main",
          createdAt: now,
          updatedAt: now,
        }),
      }) as never,
      secretEncryptor: encryptor(),
      publicBaseUrl: "https://ui.test",
      now: () => now,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "9.0" }), { status: 200 }),
    );
    const worker = createSlackLifecycleWorker(plane, {
      fetch: fetchImpl,
      worker: { now: () => now },
    });
    expect(worker).toBeDefined();
    expect(plane.state.slackOutboundEnabled).toBe(true);
    expect(await worker!.runOnce()).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string)).toMatchObject({
      channel: "C123",
      text: expect.stringContaining("auto-harness"),
    });
  });

  it("falls back to in-memory Slack config and skips disabled integrations", async () => {
    const store = new MemoryOutbox();
    const plane = new ControlPlane({ storage: store as never, secretEncryptor: encryptor() });
    plane.state.slackIntegration = { ...slackRecord(), enabled: false };
    const fetchImpl = vi.fn();
    const worker = createSlackLifecycleWorker(plane, {
      fetch: fetchImpl,
      worker: { now: () => now },
    });
    expect(await worker!.runOnce()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reconciles active and just-completed sessions and loads stderr for failures", async () => {
    const store = new MemoryOutbox();
    const sessions = new Map([
      [
        "running-1",
        {
          id: "running-1",
          repositoryId: "repo-1",
          prompt: "active",
          target: { commandId: "command-1" },
          fallbacks: [],
          targetLabels: ["Codex"],
          queueTtlSeconds: 60,
          queueExpiresAt: now,
          timeout: 60,
          priority: 4,
          requiredLabels: [],
          status: "running",
          queueShard: 0,
          createdAt: now,
          startedAt: now,
        },
      ],
    ]);
    const listLogs = vi.fn(async () => [
      { stream: "stderr", content: "boom", timestampSeq: "1", sessionId: "failed-1" },
    ]);
    let listRunning = true;
    const plane = new ControlPlane({
      storage: Object.assign(store, {
        getSlackIntegration: async () => slackRecord(),
        listSessionsByStatus: async (status: string) =>
          status === "running" && listRunning ? [[...sessions.values()][0]] : [],
        getSession: async (id: string) =>
          id === "running-1"
            ? {
                ...sessions.get("running-1"),
                status: "failed",
                completedAt: now,
                exitCode: 1,
              }
            : null,
        listLogs,
      }) as never,
      secretEncryptor: encryptor(),
      publicBaseUrl: "https://ui.test",
      now: () => now,
    });
    plane.state.sessions.set("ancient", {
      id: "ancient",
      repositoryId: "repo-1",
      prompt: "old",
      target: { commandId: "command-1" },
      fallbacks: [],
      targetLabels: ["Codex"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2016-01-01T00:00:00.000Z",
      timeout: 60,
      priority: 4,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2016-01-01T00:00:00.000Z",
      completedAt: "2016-01-01T00:00:00.000Z",
    } as never);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.0" }), { status: 200 }),
    );
    const worker = createSlackLifecycleWorker(plane, {
      fetch: fetchImpl,
      worker: { now: () => now, maxOperationsPerTick: 20 },
    });
    expect(await worker!.runOnce()).toBe(true);
    expect(await worker!.runOnce()).toBe(true);
    listRunning = false;
    expect(await worker!.runOnce()).toBe(true);
    expect(listLogs).toHaveBeenCalledWith("running-1");
    expect(
      fetchImpl.mock.calls.some((call) => String(call[1].body).includes("Session failed")),
    ).toBe(true);
    expect(fetchImpl.mock.calls.some((call) => String(call[1].body).includes("old"))).toBe(false);
  });

  it("skips missing Slack config, in-memory sessions, and non-reconcileable statuses", async () => {
    const store = new MemoryOutbox();
    const plane = new ControlPlane({
      storage: store as never,
      secretEncryptor: encryptor(),
      publicBaseUrl: "https://ui.test",
      now: () => now,
    });
    plane.state.sessions.set("queued-memory", sessionRecord("queued-memory", "queued"));
    plane.state.sessions.set("ghost", sessionRecord("ghost", "paused"));
    plane.state.sessions.set(
      "completed-memory",
      sessionRecord("completed-memory", "completed", {
        createdAt: "2016-01-01T00:00:00.000Z",
      }),
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "2.0" }), { status: 200 }),
    );
    const worker = createSlackLifecycleWorker(plane, {
      fetch: fetchImpl,
      worker: { now: () => now },
    });
    expect(await worker!.runOnce()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    plane.state.slackIntegration = slackRecord();
    expect(await worker!.runOnce()).toBe(true);
    expect(
      fetchImpl.mock.calls.some((call) => String(call[1].body).includes("queued-memory")),
    ).toBe(true);
    expect(fetchImpl.mock.calls.some((call) => String(call[1].body).includes("ghost"))).toBe(false);
    expect(
      fetchImpl.mock.calls.some((call) => String(call[1].body).includes("completed-memory")),
    ).toBe(false);

    plane.state.sessions.set("queued-later", sessionRecord("queued-later", "queued"));
    let remaining = 1;
    Object.assign(store, {
      getSlackIntegration: async () => (remaining-- > 0 ? slackRecord() : null),
    });
    expect(await worker!.runOnce()).toBe(true);
  });
});
