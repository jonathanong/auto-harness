import { describe, expect, it } from "vitest";

import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

describe("workspace sessions", () => {
  it("leases a global slot, dispatches no Git target, and releases it on success", async () => {
    const { plane, messages } = workspacePlane();
    const session = createWorkspaceSession(plane);
    expect(session).toMatchObject({ repositoryId: null, workspacePoolId: "pool-1" });

    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      sessionType: "workspace",
      repositoryId: null,
      worktreeId: null,
      workspacePoolId: "pool-1",
      workspaceSlotId: "slot-1",
      setupScript: "pnpm install",
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "busy",
      currentSessionId: session.id,
    });

    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        workspaceSlotId: "slot-1",
        attemptId: "attempt-1",
        status: "completed",
      }).ok,
    ).toBe(true);
    expect(plane.getSession(session.id)).toMatchObject({
      status: "completed",
      repositoryId: null,
      workspaceSlotId: null,
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("quarantines cleanup failures, clones workspace policy, and rejects native resume", async () => {
    const { plane } = workspacePlane();
    const source = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    plane.handleHostMessage({
      type: "session:status",
      sessionId: source.id,
      worktreeId: null,
      workspaceSlotId: "slot-1",
      workspaceSlotError: "cleanup failed",
      attemptId: "attempt-1",
      status: "failed",
      errorCode: "workspace_cleanup_failed",
    });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "error",
      errorMessage: "cleanup failed",
    });
    expect(plane.resumeSession(source.id)).toEqual({
      ok: false,
      error: "workspace sessions do not support native resume",
    });
    const cloned = plane.cloneSession(source.id, { destroyWorkspaceAfter: true });
    expect(cloned).toMatchObject({
      ok: true,
      session: {
        repositoryId: null,
        workspacePoolId: "pool-1",
        destroyWorkspaceAfter: true,
        type: "workspace",
      },
    });
  });

  it("expires a queued workspace session before it attempts placement", async () => {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    plane.state.sessions.get(session.id)!.queueExpiresAt = "2026-09-11T23:59:59.000Z";

    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(plane.getSession(session.id)).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
      errorMessage: "queue TTL expired before workspace capacity became available",
    });
  });

  it("releases workspace slots on local cancellation and durable terminal reports", async () => {
    const local = workspacePlane();
    const cancelled = createWorkspaceSession(local.plane);
    await assignWorkspaceQueuedDurable(local.plane.state);
    expect(local.plane.cancelSession(cancelled.id)).toMatchObject({ ok: true });
    expect(
      local.plane.handleHostMessage({
        type: "session:status",
        sessionId: cancelled.id,
        worktreeId: null,
        attemptId: "attempt-1",
        status: "completed",
      }).ok,
    ).toBe(true);
    expect(local.plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });

    for (const [status, workspaceSlotError] of [
      ["completed", undefined],
      ["failed", "cleanup failed"],
    ] as const) {
      const durable = workspacePlane();
      const session = createWorkspaceSession(durable.plane);
      await assignWorkspaceQueuedDurable(durable.plane.state);
      const current = durable.plane.state.sessions.get(session.id)!;
      durable.plane.state.storage = {
        getSession: async () => current,
        finishSession: async () => true,
        putArchive: async () => undefined,
      } as never;
      const result = await durable.plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: "attempt-1",
        status,
        ...(workspaceSlotError ? { workspaceSlotError } : {}),
      });
      expect(result).toMatchObject({
        ok: true,
        sessionStatusAcknowledged: { sessionId: session.id },
      });
      expect(durable.plane.state.workspaceSlots.get("slot-1")).toMatchObject({
        status: workspaceSlotError ? "error" : "idle",
        currentSessionId: null,
        ...(workspaceSlotError ? { errorMessage: workspaceSlotError } : {}),
      });
    }
  });

  it("freezes trusted setup content at admission when the pool changes while queued", async () => {
    const { plane, messages } = workspacePlane();
    const session = createWorkspaceSession(plane);
    plane.state.workspacePools.get("pool-1")!.setupProfiles[0]!.script = "pnpm install --changed";

    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      setupProfileId: "node",
      setupScript: "pnpm install",
    });
    expect(plane.getSession(session.id)).not.toHaveProperty("workspaceSetupScript");
  });
});
