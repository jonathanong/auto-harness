import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  reclaimScheduledReconnect,
  requeueOmittedScheduled,
} from "./control-plane-reconnect-scheduled.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function terminalSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "terminal",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    assignmentConnectionId: "connection",
    mainCheckoutLease: true,
    ackReceivedAt: NOW,
    primaryCommandStartState: "authorized",
    ...over,
  };
}

describe("scheduled reconnect handoff coverage", () => {
  it("retains the main-checkout lease while reclaiming a terminal host loss locally", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    const session = terminalSession();
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: session.id,
      connectionId: "connection",
    });

    const requeued: string[] = [];
    await expect(reclaimScheduledReconnect(state, session, requeued)).resolves.toBe(true);

    expect(requeued).toEqual([]);
    expect(state.mainCheckoutLeases.get("host\0repo")).toEqual({
      sessionId: session.id,
      connectionId: "connection",
    });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "failed",
      terminalHookHandoff: { handoffId: "handoff", mainCheckoutLease: true },
    });
  });

  it("records terminal handoffs when an omitted session is terminalized locally", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    const session = terminalSession();
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: session.id,
      connectionId: "connection",
    });

    const handoffs: string[] = [];
    await requeueOmittedScheduled(state, "host", new Set(), [], undefined, [session], handoffs);

    expect(handoffs).toEqual([session.id]);
    expect(state.mainCheckoutLeases.get("host\0repo")).toEqual({
      sessionId: session.id,
      connectionId: "connection",
    });
  });

  it("keeps a durable terminal handoff lease when the conditional release succeeds", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    const session = terminalSession();
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: session.id,
      connectionId: "connection",
    });
    state.storage = {
      releaseMainCheckoutSession: async () => true,
    } as never;

    await expect(reclaimScheduledReconnect(state, session, [])).resolves.toBe(true);

    expect(state.mainCheckoutLeases.has("host\0repo")).toBe(true);
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "failed",
      terminalHookHandoff: { mainCheckoutLease: true },
    });
  });

  it("passes terminal handoff ids through the durable omission path", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    const session = terminalSession();
    state.storage = {
      releaseMainCheckoutSession: async () => true,
    } as never;

    const handoffs: string[] = [];
    await requeueOmittedScheduled(state, "host", new Set(), [], "omitted", [session], handoffs);

    expect(handoffs).toEqual([session.id]);
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "failed",
      terminalHookHandoff: { handoffId: "handoff" },
    });
  });
});
