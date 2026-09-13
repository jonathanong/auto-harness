import { describe, expect, it } from "vitest";

import { createControlPlaneState, settleStorage } from "./control-plane-state.ts";
import {
  expireTerminalHookHandoffIfNeeded,
  settleTerminalHookHandoff,
} from "./control-plane-terminal-hook-handoff.ts";
import type { SessionRecord } from "./db/types.ts";
import type { SlackDeliveryRecord } from "./slack-delivery-types.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRED = "2026-01-02T00:00:00.001Z";

class Outbox {
  readonly items = new Map<string, SlackDeliveryRecord>();
  calls = 0;

  async enqueue(record: SlackDeliveryRecord) {
    this.calls += 1;
    if (this.items.has(record.id)) return "exists" as const;
    this.items.set(record.id, structuredClone(record));
    return "created" as const;
  }
}

function failedHandoff(errorCode: "checkout_fetch_failed" | "host_lost"): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "failed",
    queueShard: 0,
    createdAt: NOW,
    completedAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    errorCode,
    activeHostId: "host",
    activeHostOrder: `${NOW}#session`,
    terminalHookHandoff: {
      handoffId: "handoff",
      hostId: "host",
      worktreeId: "worktree",
      repositoryId: "repo",
      status: "failed",
      errorCode,
      expiresAt: "2026-01-02T00:00:00.000Z",
      attemptId: "attempt",
    },
  };
}

function coldState(stored: SessionRecord, outbox: Outbox, expire = false) {
  const state = createControlPlaneState({ now: () => (expire ? EXPIRED : NOW) });
  state.storage = {
    getSession: async () => structuredClone(stored),
    settleTerminalHookHandoff: async () => {
      delete stored.terminalHookHandoff;
      delete stored.activeHostId;
      stored.terminalHookHandoffSettled = { handoffId: "handoff", hostId: "host" };
      return true;
    },
    expireTerminalHookHandoff: async () => {
      if (!stored.terminalHookHandoff) return false;
      stored.terminalHookHandoffExpiredAt = stored.terminalHookHandoff.expiresAt;
      delete stored.terminalHookHandoff;
      return true;
    },
    enqueue: outbox.enqueue.bind(outbox),
    getSlackIntegration: async () => ({
      id: "slack",
      type: "slack",
      enabled: true,
      defaultChannel: "#ops",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
    }),
    putArchive: async () => undefined,
    listLogs: async () => [],
  } as never;
  return state;
}

const settleInput = {
  sessionId: "session",
  handoffId: "handoff",
  hostId: "host",
  connectionId: "connection",
};

describe("deferred checkout-failure Slack lifecycle", () => {
  it("enqueues session_failed once on cold settlement", async () => {
    const stored = failedHandoff("checkout_fetch_failed");
    const outbox = new Outbox();
    const state = coldState(stored, outbox);
    await expect(settleTerminalHookHandoff(state, settleInput)).resolves.toBe(true);
    await settleStorage(state);
    expect([...outbox.items.keys()]).toContain("slack:session:session_failed:reply");
    const created = outbox.calls;
    await expect(settleTerminalHookHandoff(state, settleInput)).resolves.toBe(true);
    await settleStorage(state);
    expect(outbox.calls).toBe(created);
  });

  it("enqueues session_failed once on cold expiry", async () => {
    const stored = failedHandoff("checkout_fetch_failed");
    const outbox = new Outbox();
    const state = coldState(stored, outbox, true);
    await expect(
      expireTerminalHookHandoffIfNeeded(state, structuredClone(stored), Date.parse(EXPIRED)),
    ).resolves.toBe(true);
    await settleStorage(state);
    expect([...outbox.items.keys()]).toContain("slack:session:session_failed:reply");
    const created = outbox.calls;
    await expect(
      expireTerminalHookHandoffIfNeeded(state, structuredClone(stored), Date.parse(EXPIRED)),
    ).resolves.toBe(false);
    await settleStorage(state);
    expect(outbox.calls).toBe(created);
  });

  it("leaves host-loss settlement off the Slack outbox", async () => {
    const stored = failedHandoff("host_lost");
    const outbox = new Outbox();
    const state = coldState(stored, outbox);
    await expect(settleTerminalHookHandoff(state, settleInput)).resolves.toBe(true);
    await settleStorage(state);
    expect(outbox.calls).toBe(0);
  });
});
