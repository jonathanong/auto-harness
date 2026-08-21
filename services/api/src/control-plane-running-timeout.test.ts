import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  RUNNING_TIMEOUT_NOW as NOW,
  runningDeadlineMs,
  startAcknowledgedRunning,
} from "./control-plane-running-timeout-test-helpers.ts";

describe("acknowledged running sessions converge or time out", () => {
  it("applies a successful host completion to the public session and releases the worktree", () => {
    const plane = new ControlPlane({ now: () => NOW });
    const { sessionId, worktreeId } = startAcknowledgedRunning(plane);
    const session = plane.getSession(sessionId)!;
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId,
        worktreeId,
        attemptId: session.attemptId!,
        status: "completed",
        exitCode: 0,
      }).ok,
    ).toBe(true);
    const publicSession = plane.getSession(sessionId)!;
    expect(publicSession.status).toBe("completed");
    expect(publicSession.exitCode).toBe(0);
    expect(publicSession.completedAt).toBe(NOW);
    expect(plane.getWorktree(worktreeId)?.status).toBe("idle");
    expect(plane.getWorktree(worktreeId)?.currentSessionId).toBeNull();
  });

  it("ignores a rejected terminal report then applies a later matching completion", () => {
    const plane = new ControlPlane({ now: () => NOW });
    const { sessionId, worktreeId } = startAcknowledgedRunning(plane);
    const session = plane.getSession(sessionId)!;
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId,
        worktreeId,
        attemptId: "stale-attempt",
        status: "completed",
        exitCode: 0,
      }).ok,
    ).toBe(true);
    expect(plane.getSession(sessionId)?.status).toBe("running");
    expect(plane.getSession(sessionId)?.completedAt).toBeUndefined();
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId,
        worktreeId,
        attemptId: session.attemptId!,
        status: "completed",
        exitCode: 0,
      }).ok,
    ).toBe(true);
    expect(plane.getSession(sessionId)?.status).toBe("completed");
    expect(plane.getWorktree(worktreeId)?.status).toBe("idle");
  });

  it("times out an acknowledged running assignment at startedAt + timeout", () => {
    const plane = new ControlPlane({ now: () => NOW });
    const { sessionId, worktreeId } = startAcknowledgedRunning(plane);
    const due = runningDeadlineMs(plane, sessionId);
    expect(plane.enforceRunningTimeouts(due - 1)).toEqual([]);
    expect(plane.getSession(sessionId)?.status).toBe("running");
    expect(plane.enforceRunningTimeouts(due)).toEqual([sessionId]);
    const timedOut = plane.getSession(sessionId)!;
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.completedAt).toBe(NOW);
    expect(timedOut.errorMessage).toMatch(/timeout/);
    expect(plane.getWorktree(worktreeId)?.status).toBe("idle");
    expect(plane.getWorktree(worktreeId)?.currentSessionId).toBeNull();
  });
});
