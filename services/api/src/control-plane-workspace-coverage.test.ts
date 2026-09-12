/* eslint-disable max-lines -- workspace lifecycle boundaries share one fixture. */
import { describe, expect, it } from "vitest";

import { disconnectHost } from "./control-plane-agents.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

describe("workspace control-plane branch boundaries", () => {
  it("finishes a cancelled workspace assignment durably and quarantines its exact slot", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    expect(plane.cancelSession(session.id)).toMatchObject({ ok: true });

    const current = plane.state.sessions.get(session.id)!;
    let finish: Record<string, unknown> | undefined;
    plane.state.storage = {
      getSession: async () => current,
      finishSession: async (options: Record<string, unknown>) => {
        finish = options;
        return true;
      },
      putArchive: async () => undefined,
    } as never;

    await expect(
      plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: "attempt-1",
        status: "completed",
        workspaceSlotError: "destroy failed",
      }),
    ).resolves.toMatchObject({
      ok: true,
      sessionStatusAcknowledged: { sessionId: session.id, attemptId: "attempt-1" },
    });
    expect(finish).toMatchObject({
      sessionId: session.id,
      expectedStatus: "cancelled",
      workspaceSlotId: "slot-1",
      workspaceSlotError: "destroy failed",
    });
    expect(plane.getSession(session.id)).toMatchObject({
      status: "cancelled",
      workspaceSlotId: null,
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "error",
      currentSessionId: null,
      errorMessage: "destroy failed",
    });
  });

  it("does not release another session's local workspace slot on a late report", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const slot = plane.state.workspaceSlots.get("slot-1")!;
    plane.state.workspaceSlots.set(slot.id, { ...slot, currentSessionId: "replacement" });

    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: "attempt-1",
        status: "completed",
      }),
    ).toMatchObject({ ok: true });
    expect(plane.getSession(session.id)).toMatchObject({
      status: "completed",
      workspaceSlotId: null,
    });
    expect(plane.state.workspaceSlots.get(slot.id)).toMatchObject({
      status: "busy",
      currentSessionId: "replacement",
    });
  });

  it("requeues a running workspace slot on local disconnect while retaining quarantines", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const connectionId = plane.state.hostConnection.get("host-1")!;

    expect(disconnectHost(plane.state, connectionId)).toEqual([session.id]);
    expect(plane.getSession(session.id)).toMatchObject({
      status: "queued",
      hostId: null,
      workspaceSlotId: null,
      errorMessage: "agent disconnected; requeued",
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "idle",
      online: false,
      currentSessionId: null,
    });

    plane.state.workspaceSlots.set("slot-1", {
      ...plane.state.workspaceSlots.get("slot-1")!,
      status: "error",
      errorMessage: "needs operator repair",
    });
    const replacement = plane.registerHost({
      hostId: "host-1",
      worktrees: [],
      capabilities: ["workspace-sessions"],
      replaceExisting: true,
    });
    expect(replacement).toMatchObject({ ok: true });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "error",
      online: false,
      errorMessage: "needs operator repair",
    });
    expect(disconnectHost(plane.state, plane.state.hostConnection.get("host-1")!)).toEqual([]);
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "error",
      online: false,
      currentSessionId: null,
    });

    const cancelled = workspacePlane();
    const cancelledSession = createWorkspaceSession(cancelled.plane);
    await assignWorkspaceQueuedDurable(cancelled.plane.state);
    expect(cancelled.plane.cancelSession(cancelledSession.id)).toMatchObject({ ok: true });
    expect(
      disconnectHost(cancelled.plane.state, cancelled.plane.state.hostConnection.get("host-1")!),
    ).toEqual([]);
    expect(cancelled.plane.getSession(cancelledSession.id)).toMatchObject({
      status: "cancelled",
      hostId: null,
      workspaceSlotId: null,
    });
  });

  it("preserves slot state across inventory edits and rejects unsafe workspace attachments", () => {
    const { plane } = workspacePlane();
    const inventory = {
      repositories: [],
      allowedRoots: ["/srv/workspaces"],
      workspacePools: [
        {
          workspacePoolId: "pool-1",
          slots: [{ id: "slot-1", name: "one", path: "/srv/workspaces/one" }],
        },
      ],
    };
    const slot = plane.state.workspaceSlots.get("slot-1")!;
    plane.state.workspaceSlots.set(slot.id, {
      ...slot,
      status: "error",
      errorMessage: "repair before reuse",
    });

    expect(plane.putHostInventory("host-1", inventory)).toMatchObject({ ok: true });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "error",
      errorMessage: "repair before reuse",
    });
    expect(
      plane.putHostInventory("host-1", {
        ...inventory,
        workspacePools: [{ workspacePoolId: "missing", slots: [] }],
      }),
    ).toEqual({ ok: false, error: "unknown workspacePoolId: missing" });
    expect(plane.putHostInventory("host-2", inventory)).toEqual({
      ok: false,
      error: "workspace slot id already in use: slot-1",
    });

    plane.state.workspaceSlots.set("slot-1", {
      ...plane.state.workspaceSlots.get("slot-1")!,
      status: "busy",
      currentSessionId: "running",
    });
    expect(plane.putHostInventory("host-1", inventory)).toMatchObject({ ok: true });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "busy",
      currentSessionId: "running",
    });
    expect(
      plane.putHostInventory("host-1", {
        ...inventory,
        workspacePools: [
          {
            workspacePoolId: "pool-1",
            slots: [{ id: "slot-1", name: "one", path: "/srv/workspaces/replaced" }],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "cannot change the path or pool of busy workspace slot: slot-1",
    });

    plane.state.workspaceSlots.set("slot-1", {
      ...plane.state.workspaceSlots.get("slot-1")!,
      status: "idle",
      currentSessionId: null,
    });
    expect(plane.deleteHostInventory("host-1")).toEqual({ ok: true });
    expect(plane.state.workspaceSlots.has("slot-1")).toBe(false);

    const removal = workspacePlane().plane;
    expect(
      removal.putHostInventory("host-1", {
        repositories: [],
        allowedRoots: ["/srv/workspaces"],
      }),
    ).toMatchObject({ ok: true });
    expect(removal.state.workspaceSlots.has("slot-1")).toBe(false);
  });
});

it("retires a removed busy slot until its exact owner reports terminal", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);

  expect(
    plane.putHostInventory("host-1", {
      repositories: [],
      allowedRoots: ["/srv/workspaces"],
    }),
  ).toMatchObject({ ok: true });
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
    status: "busy",
    currentSessionId: session.id,
    online: false,
    retired: true,
  });

  expect(
    plane.handleHostMessage({
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: "attempt-1",
      status: "completed",
    }),
  ).toMatchObject({ ok: true });
  expect(plane.state.workspaceSlots.has("slot-1")).toBe(false);
});
