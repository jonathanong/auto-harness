import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { pendingTerminalHookHandoffs } from "./control-plane-terminal-hook-handoff.ts";
import { indexPendingTerminalHookHandoff } from "./control-plane-terminal-hook-handoff-index.ts";
import { finishHostLostSession } from "./control-plane-infrastructure-retry.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(overrides: Partial<SessionRecord> = {}): SessionRecord {
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
    ...overrides,
  };
}

function pending(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const owner = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
  return finishHostLostSession(owner, running(overrides));
}

describe("in-memory pending terminal-hook handoff host index", () => {
  it("lists outstanding handoffs without scanning unrelated sessions", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const handoff = pending();
    state.sessions.set(handoff.id, handoff);
    for (let i = 0; i < 20; i += 1) {
      state.sessions.set(`noise-${String(i)}`, running({ id: `noise-${String(i)}` }));
    }
    const originalValues = state.sessions.values.bind(state.sessions);
    let scanned = false;
    state.sessions.values = () => {
      scanned = true;
      return originalValues();
    };

    await expect(
      pendingTerminalHookHandoffs(state, "host", { protocolVersion: 7 }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "session",
      }),
    ]);
    expect(scanned).toBe(false);
    expect(state.pendingTerminalHookHandoffsByHost.get("host")).toEqual(new Set(["session"]));
  });

  it("drops a session from the host index when its handoff is cleared", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const handoff = pending();
    state.sessions.set(handoff.id, handoff);
    expect(state.pendingTerminalHookHandoffsByHost.get("host")?.has("session")).toBe(true);
    state.sessions.set(handoff.id, running());
    expect(state.pendingTerminalHookHandoffsByHost.has("host")).toBe(false);
    state.sessions.set(handoff.id, handoff);
    state.sessions.delete(handoff.id);
    expect(state.pendingTerminalHookHandoffsByHost.has("host")).toBe(false);
  });

  it("keeps the host bucket until the last indexed session is removed", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const first = pending({ id: "first" });
    const second = pending({ id: "second" });
    state.sessions.set(first.id, first);
    state.sessions.set(second.id, second);
    expect(state.pendingTerminalHookHandoffsByHost.get("host")).toEqual(
      new Set(["first", "second"]),
    );
    state.sessions.set(first.id, running({ id: "first" }));
    expect(state.pendingTerminalHookHandoffsByHost.get("host")).toEqual(new Set(["second"]));
    state.sessions.delete(second.id);
    expect(state.pendingTerminalHookHandoffsByHost.has("host")).toBe(false);
  });

  it("clears the host index and ignores stale session ids", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const handoff = pending();
    state.sessions.set(handoff.id, handoff);
    state.sessions.clear();
    expect(state.pendingTerminalHookHandoffsByHost.has("host")).toBe(false);
    state.pendingTerminalHookHandoffsByHost.set("host", new Set(["missing"]));
    await expect(
      pendingTerminalHookHandoffs(state, "host", { protocolVersion: 7 }),
    ).resolves.toEqual([]);
    state.pendingTerminalHookHandoffsByHost.delete("host");
    indexPendingTerminalHookHandoff(state, pending({ id: "never-indexed" }), undefined);
    expect(state.pendingTerminalHookHandoffsByHost.has("host")).toBe(false);
    await expect(
      pendingTerminalHookHandoffs(state, "host", { protocolVersion: 7 }),
    ).resolves.toEqual([]);
  });
});
