import { describe, expect, it } from "vitest";

import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

describe("workspace session lifecycle recovery", () => {
  it("releases its exact slot when the control-plane running timeout wins", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const assigned = plane.getSession(session.id)!;
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: session.id,
        worktreeId: null,
        attemptId: assigned.attemptId!,
      }).ok,
    ).toBe(true);

    expect(plane.enforceRunningTimeouts(Date.parse("2026-09-12T00:01:00.000Z"))).toEqual([
      session.id,
    ]);
    expect(plane.getSession(session.id)).toMatchObject({
      status: "timed_out",
      workspaceSlotId: null,
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("includes the exact workspace slot in the durable timeout transition", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const assigned = plane.getSession(session.id)!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: session.id,
      worktreeId: null,
      attemptId: assigned.attemptId!,
    });
    const acknowledged = plane.getSession(session.id)!;
    let finishOpts: Record<string, unknown> | undefined;
    plane.state.storage = {
      listSessionsByStatus: async () => [acknowledged],
      finishSession: async (opts: Record<string, unknown>) => {
        finishOpts = opts;
        return true;
      },
      putArchive: async () => undefined,
    } as never;

    await expect(
      plane.enforceRunningTimeoutsDurable(Date.parse("2026-09-12T00:01:00.000Z")),
    ).resolves.toEqual([session.id]);
    expect(finishOpts).toMatchObject({
      sessionId: session.id,
      worktreeId: null,
      workspaceSlotId: "slot-1",
      status: "timed_out",
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("requeues an omitted workspace attempt and frees its slot on keepalive", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);

    await expect(
      reconcileHostOwnedSessions(
        plane.state,
        "host-1",
        plane.state.hostConnection.get("host-1"),
        new Set(),
        "daemon no longer reports session as running; requeued",
      ),
    ).resolves.toEqual([session.id]);
    expect(plane.getSession(session.id)).toMatchObject({
      status: "queued",
      workspaceSlotId: null,
      hostId: null,
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });
});
