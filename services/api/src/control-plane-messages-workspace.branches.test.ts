/* eslint-disable max-lines -- workspace terminal branches share one assignment fixture. */
import { expect, it, vi } from "vitest";

import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

it("releases a local workspace slot and preserves the operator error", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);

  expect(
    handleHostMessage(plane.state, {
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: "attempt-1",
      status: "completed",
      workspaceSlotError: "workspace cleanup failed",
    }),
  ).toEqual({ ok: true });
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
    status: "error",
    currentSessionId: null,
    errorMessage: "workspace cleanup failed",
  });
  expect(plane.getSession(session.id)).toMatchObject({
    status: "completed",
    workspaceSlotId: null,
  });
});

it("handles a late durable terminal from a timed-out workspace attempt", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);
  const current = plane.state.sessions.get(session.id)!;
  current.status = "timed_out";
  current.completedAt = "2026-09-12T00:00:00.000Z";
  plane.state.sessions.set(session.id, current);
  const slot = plane.state.workspaceSlots.get("slot-1")!;
  let finishOptions: Record<string, unknown> | undefined;
  plane.state.storage = {
    getSession: async () => current,
    finishSession: async (options: Record<string, unknown>) => {
      finishOptions = options;
      return true;
    },
    putArchive: async () => undefined,
  } as never;

  await expect(
    handleHostMessageDurable(plane.state, {
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: current.attemptId!,
      status: "completed",
      workspaceSlotError: "late cleanup failure",
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(finishOptions).toMatchObject({
    sessionId: session.id,
    workspaceSlotId: slot.id,
    expectedStatus: "timed_out",
    workspaceSlotError: "late cleanup failure",
  });
  expect(plane.state.workspaceSlots.get(slot.id)).toMatchObject({
    status: "error",
    currentSessionId: null,
    errorMessage: "late cleanup failure",
  });
  expect(plane.getSession(session.id)).toMatchObject({
    status: "timed_out",
    workspaceSlotId: null,
  });
});

it("accepts a late timed-out terminal without a workspace cleanup error", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);
  const current = plane.state.sessions.get(session.id)!;
  current.status = "timed_out";
  current.completedAt = "2026-09-12T00:00:00.000Z";
  plane.state.sessions.set(session.id, current);
  plane.state.storage = {
    getSession: async () => current,
    finishSession: async () => true,
    putArchive: async () => undefined,
  } as never;

  await expect(
    handleHostMessageDurable(plane.state, {
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: current.attemptId!,
      status: "completed",
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});

it("withholds acknowledgement when a timed-out workspace cleanup loses its fence", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);
  const current = plane.state.sessions.get(session.id)!;
  current.status = "timed_out";
  current.completedAt = "2026-09-12T00:00:00.000Z";
  plane.state.sessions.set(session.id, current);
  plane.state.storage = {
    getSession: async () => current,
    finishSession: async () => false,
  } as never;

  await expect(
    handleHostMessageDurable(plane.state, {
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: current.attemptId!,
      status: "completed",
    }),
  ).resolves.toEqual({ ok: true });
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
    status: "busy",
    currentSessionId: session.id,
  });
});

it("releases a cancelled durable workspace slot without an error marker", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);
  const current = plane.state.sessions.get(session.id)!;
  current.status = "cancelled";
  plane.state.sessions.set(session.id, current);
  let finishes = 0;
  plane.state.storage = {
    getSession: async () => current,
    finishSession: async () => ((finishes += 1), true),
    putArchive: async () => undefined,
  } as never;

  await expect(
    handleHostMessageDurable(plane.state, {
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: current.attemptId!,
      status: "completed",
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(finishes).toBe(1);
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});

it("persists workspace cleanup errors for cancelled and completed durable sessions", async () => {
  for (const status of ["cancelled", "running"] as const) {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const current = plane.state.sessions.get(session.id)!;
    current.status = status;
    plane.state.sessions.set(session.id, current);
    let finish: Record<string, unknown> | undefined;
    plane.state.storage = {
      getSession: async () => current,
      finishSession: async (input: Record<string, unknown>) => {
        finish = input;
        return true;
      },
      putArchive: async () => undefined,
    } as never;

    await expect(
      handleHostMessageDurable(plane.state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: current.attemptId!,
        status: "completed",
        workspaceSlotError: "cleanup failed",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(finish).toMatchObject({ workspaceSlotError: "cleanup failed" });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: "error",
      currentSessionId: null,
      errorMessage: "cleanup failed",
    });
  }
});

it("requeues a usage-limited workspace session and releases its exact slot", async () => {
  for (const workspaceSlotError of [undefined, "cleanup failed"] as const) {
    const { plane } = workspacePlane();
    const session = createWorkspaceSession(plane);
    await assignWorkspaceQueuedDurable(plane.state);
    const current = plane.state.sessions.get(session.id)!;
    const account = {
      id: "account",
      providerId: "provider",
      label: "account@example.test",
      usageLimitCooldownSeconds: 60,
      maxConcurrentSessions: 1,
    };
    plane.state.providerAccounts.set(account.id, account);
    current.resolvedRoute = {
      ...current.resolvedRoute!,
      providerId: account.providerId,
      providerAccountId: account.id,
    };
    plane.state.sessions.set(session.id, current);
    plane.state.storage = {
      getSession: async () => current,
      getProviderAccount: async () => account,
      requeueUsageLimitedWorkspaceSession: async () => true,
    } as never;

    await expect(
      handleHostMessageDurable(plane.state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: current.attemptId!,
        status: "failed",
        errorCode: "usage_limit",
        ...(workspaceSlotError === undefined ? {} : { workspaceSlotError }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
      status: workspaceSlotError === undefined ? "idle" : "error",
      currentSessionId: null,
      ...(workspaceSlotError === undefined ? {} : { errorMessage: workspaceSlotError }),
    });
    expect(plane.state.providerAccounts.get(account.id)).toMatchObject({
      usageLimitedUntil: "2026-09-12T00:01:00.000Z",
    });
  }
});

it("atomically suppresses a providerless workspace target and requeues it", async () => {
  const { plane } = workspacePlane();
  const session = createWorkspaceSession(plane);
  await assignWorkspaceQueuedDurable(plane.state);
  const current = plane.state.sessions.get(session.id)!;
  const suppress = vi.fn(async () => true);
  plane.state.storage = {
    getSession: async () => current,
    suppressProviderlessUsageLimitWorkspace: suppress,
  } as never;

  await expect(
    handleHostMessageDurable(plane.state, {
      type: "session:status",
      sessionId: session.id,
      worktreeId: null,
      attemptId: current.attemptId!,
      status: "failed",
      errorCode: "usage_limit",
      errorMessage: "workspace quota",
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(suppress).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: session.id,
      workspaceSlotId: "slot-1",
      attemptId: current.attemptId,
      targetIndex: 0,
      errorMessage: "workspace quota",
    }),
  );
  expect(plane.state.sessions.get(session.id)).toMatchObject({
    status: "queued",
    workspaceSlotId: null,
    hostId: null,
    suppressedTargetIndexes: [0],
  });
  expect(plane.state.sessions.get(session.id)).not.toHaveProperty("workspaceSlotLease");
  expect(plane.state.workspaceSlots.get("slot-1")).toMatchObject({
    status: "idle",
    currentSessionId: null,
  });
});
