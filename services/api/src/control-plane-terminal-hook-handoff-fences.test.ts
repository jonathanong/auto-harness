import { describe, expect, it } from "vitest";

import { finishHostLostSession } from "./control-plane-infrastructure-retry.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import {
  pendingTerminalHookHandoffs,
  settleTerminalHookHandoff,
  TERMINAL_HOOK_HANDOFF_DELIVERY_LIMIT,
} from "./control-plane-terminal-hook-handoff.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(): SessionRecord {
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
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    activeHostId: "host",
    activeHostOrder: `${NOW}#session`,
  };
}

function state() {
  const current = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
  current.hostConnection.set("host", "connection");
  current.connections.set("connection", {
    type: "host",
    hostId: "host",
    connectionId: "connection",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    repositoryIds: ["repo"],
    capabilities: [],
    protocolVersion: 5,
  });
  return current;
}

describe("terminal hook handoff bounds and local fences", () => {
  it("bounds each registration delivery batch", async () => {
    const current = state();
    for (let index = 0; index <= TERMINAL_HOOK_HANDOFF_DELIVERY_LIMIT; index += 1) {
      const session = running();
      session.id = `session-${String(index)}`;
      const finished = finishHostLostSession(current, session);
      current.sessions.set(finished.id, finished);
    }
    await expect(pendingTerminalHookHandoffs(current, "host")).resolves.toHaveLength(
      TERMINAL_HOOK_HANDOFF_DELIVERY_LIMIT,
    );
  });

  it("fences in-memory settlement to the host's current connection", async () => {
    const current = state();
    const finished = finishHostLostSession(current, running());
    current.sessions.set(finished.id, finished);
    const input = { sessionId: "session", handoffId: "handoff", hostId: "host" };

    await expect(
      settleTerminalHookHandoff(current, { ...input, connectionId: "stale" }),
    ).resolves.toBe(false);
    expect(current.sessions.get("session")?.terminalHookHandoff).toBeDefined();
    await expect(
      settleTerminalHookHandoff(current, { ...input, connectionId: "connection" }),
    ).resolves.toBe(true);
  });

  it("acknowledges only the exact settled in-memory handoff", async () => {
    const current = state();
    const input = { handoffId: "handoff", hostId: "host", connectionId: "connection" };
    await expect(
      settleTerminalHookHandoff(current, { ...input, sessionId: "missing" }),
    ).resolves.toBe(false);

    const finished = finishHostLostSession(current, running());
    delete finished.terminalHookHandoff;
    finished.terminalHookHandoffSettled = { handoffId: "handoff", hostId: "host" };
    current.sessions.set(finished.id, finished);
    await expect(
      settleTerminalHookHandoff(current, { ...input, sessionId: "session" }),
    ).resolves.toBe(true);
    await expect(
      settleTerminalHookHandoff(current, { ...input, sessionId: "session", handoffId: "other" }),
    ).resolves.toBe(false);
    await expect(
      settleTerminalHookHandoff(current, { ...input, sessionId: "session", hostId: "other" }),
    ).resolves.toBe(false);
  });
});
