import { describe, expect, it } from "vitest";

import { hydrateScheduledState } from "./control-plane-hydrate-scheduled.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    commandId: "cmd",
    targetLabel: "cmd",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    ...over,
  };
}

describe("hydrateScheduledState", () => {
  it("indexes main-checkout leases and skips sessions that cannot hold one", () => {
    const state = {
      sessions: new Map<string, SessionRecord>([["stale", session({ id: "stale" })]]),
      pendingAcks: { clear: () => undefined },
      mainCheckoutLeases: new Map([["old", { sessionId: "stale", connectionId: "gone" }]]),
    };
    hydrateScheduledState(state, [
      session({ id: "plain" }),
      session({
        id: "leased",
        hostId: "host",
        assignmentConnectionId: "conn",
        mainCheckoutLease: true,
      }),
      session({
        id: "incomplete",
        hostId: "host",
        mainCheckoutLease: true,
      }),
    ]);
    expect([...state.sessions.keys()]).toEqual(["plain", "leased", "incomplete"]);
    expect([...state.mainCheckoutLeases.entries()]).toEqual([
      ["host\0repo", { sessionId: "leased", connectionId: "conn" }],
    ]);
  });
});
