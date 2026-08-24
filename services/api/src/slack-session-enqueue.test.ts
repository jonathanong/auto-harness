import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { settleStorage } from "./control-plane-state.ts";
import { seedBaseCommand, baseSessionBody } from "./control-plane-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackDeliveryRecord, SlackOutboxStore } from "./slack-delivery-types.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";
import { SlackLifecycleWorker } from "./slack-worker.ts";

const now = "2026-08-12T10:00:00.000Z";
const token = "xoxb-1234567890-abcdefghij";

class SessionOutbox implements SlackOutboxStore {
  readonly items = new Map<string, SlackDeliveryRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  slack: SlackIntegrationRecord | null = null;

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

  async putSession(session: SessionRecord) {
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(id: string) {
    return structuredClone(this.sessions.get(id) ?? null);
  }

  async finishSession(input: {
    sessionId: string;
    status: SessionRecord["status"];
    completedAt?: string;
    exitCode?: number;
  }) {
    const session = this.sessions.get(input.sessionId);
    if (!session) return false;
    this.sessions.set(input.sessionId, {
      ...session,
      status: input.status,
      worktreeId: null,
      hostId: null,
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    });
    return true;
  }

  async listLogs() {
    return [];
  }

  async putArchive() {}

  async putCommand() {}

  async getSlackIntegration() {
    return this.slack ? { ...this.slack } : null;
  }

  async putSlackIntegration(record: SlackIntegrationRecord) {
    this.slack = { ...record };
    return true;
  }
}

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (plaintext) => Buffer.from(plaintext, "utf8").toString("base64"),
    decrypt: async (ciphertext) => Buffer.from(ciphertext, "base64").toString("utf8"),
  };
}

async function slackPlane(sessionId: string) {
  const store = new SessionOutbox();
  const plane = new ControlPlane({
    storage: store as never,
    secretEncryptor: encryptor(),
    now: () => now,
    idFactory: () => sessionId,
  });
  seedBaseCommand(plane);
  plane.state.repositories.set("repo-1", {
    id: "repo-1",
    name: "auto-harness",
    url: "git@example.test:auto-harness.git",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await plane.createSlackIntegrationDurable({
    botToken: token,
    defaultChannel: "#harness",
  });
  return { store, plane };
}

describe("Slack enqueue on session transitions", () => {
  it("records outbox rows for create-then-cancel even if this worker never saw the session as active", async () => {
    const { store, plane } = await slackPlane("session-short");
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);
    expect(plane.cancelSession("session-short")).toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
    await settleStorage(plane.state);
    expect([...store.items.keys()]).toEqual(
      expect.arrayContaining([
        "slack:session-short:thread",
        "slack:session-short:session_cancelled:reply",
        "slack:session-short:session_cancelled:update",
      ]),
    );

    const deliver = vi.fn(async (request: { channel: string; idempotencyKey: string }) => ({
      channel: request.channel,
      messageTs: `ts-${request.idempotencyKey}`,
    }));
    const worker = new SlackLifecycleWorker(
      {
        store,
        transport: { deliver },
        getConfig: async () => ({
          enabled: true,
          defaultChannel: "#harness",
          notifications: DEFAULT_SLACK_NOTIFICATIONS,
        }),
        listSessions: async () => [],
      },
      { now: () => now },
    );
    expect(await worker.runOnce()).toBe(true);
    expect(deliver.mock.calls.map(([request]) => request.operation)).toEqual([
      "post-root",
      "post-reply",
      "update-root",
    ]);
  });

  it("enqueues terminal lifecycle rows from a durable WebSocket completion", async () => {
    const { store, plane } = await slackPlane("session-ws");
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);
    await settleStorage(plane.state);
    const created = plane.state.sessions.get("session-ws");
    expect(created).toBeDefined();
    const running = {
      ...created!,
      status: "running" as const,
      worktreeId: "wt-1",
      attemptId: "attempt-1",
      hostId: "host-1",
      startedAt: now,
    };
    plane.state.sessions.set(running.id, running);
    store.sessions.set(running.id, structuredClone(running));
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:status",
          sessionId: running.id,
          worktreeId: "wt-1",
          attemptId: "attempt-1",
          status: "completed",
          exitCode: 0,
        })
      ).ok,
    ).toBe(true);
    await settleStorage(plane.state);
    expect([...store.items.keys()]).toEqual(
      expect.arrayContaining([
        "slack:session-ws:thread",
        "slack:session-ws:session_started:reply",
        "slack:session-ws:session_completed:reply",
        "slack:session-ws:session_completed:update",
      ]),
    );
  });
});
