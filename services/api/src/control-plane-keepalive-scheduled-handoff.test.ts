import { describe, expect, it } from "vitest";

import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
import {
  NOW,
  runningSessionFixture,
  seedConnectedHost,
} from "../test-helpers/control-plane-keepalive-reconcile-test-helpers.ts";

function scheduledSession(): SessionRecord {
  return {
    ...runningSessionFixture(),
    repositoryId: "repo",
    worktreeId: null,
    mainCheckoutLease: true,
    assignmentConnectionId: "c",
    ackReceivedAt: NOW,
    primaryCommandStartState: "authorized",
    activeHostId: "h",
    activeHostOrder: `${NOW}#s`,
  } as SessionRecord;
}

describe("keepalive-driven scheduled handoff reconciliation", () => {
  it("returns terminal-hook handoffs from local and durable reconciliation", async () => {
    const local = createControlPlaneState({ now: () => NOW, idFactory: () => "local-handoff" });
    seedConnectedHost(local);
    local.connections.set("c", { ...local.connections.get("c")!, protocolVersion: 6 });
    local.sessions.set("s", scheduledSession());
    local.mainCheckoutLeases.set("h\0repo", { sessionId: "s", connectionId: "c" });

    await expect(
      handleHostMessageDurable(local, {
        type: "host:keepalive",
        hostId: "h",
        at: NOW,
        runningSessions: [],
      }),
    ).resolves.toMatchObject({
      terminalHookHandoffs: [
        expect.objectContaining({ sessionId: "s", handoffId: "local-handoff" }),
      ],
    });

    const durable = createControlPlaneState({
      now: () => NOW,
      idFactory: () => "durable-handoff",
    });
    seedConnectedHost(durable);
    durable.connections.set("c", { ...durable.connections.get("c")!, protocolVersion: 6 });
    const original = scheduledSession();
    let persisted = original;
    durable.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listActiveSessionsByHost: async () => [original],
      releaseMainCheckoutSession: async (input: {
        terminalHookHandoff?: SessionRecord["terminalHookHandoff"];
      }) => {
        if (!input.terminalHookHandoff) return false;
        persisted = {
          ...original,
          status: "failed",
          terminalHookHandoff: input.terminalHookHandoff,
        };
        return true;
      },
      getSession: async () => persisted,
    } as never;

    await expect(
      handleHostMessageDurable(
        durable,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: [] },
        "c",
        false,
        false,
        6,
      ),
    ).resolves.toMatchObject({
      terminalHookHandoffs: [
        expect.objectContaining({ sessionId: "s", handoffId: "durable-handoff" }),
      ],
    });
  });
});
