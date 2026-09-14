import { describe, expect, it } from "vitest";

import {
  claimUnackedOnWorktree,
  durableRunning,
  durableWorktree,
  expectFailedReplace,
  loseSessionAfterValidation,
  readyRollbackPlane,
} from "../test-helpers/control-plane-register-rollback-test-helpers.ts";

describe("storage-less register rollback assignment", () => {
  it("assigns a requeued unacked replacement claim onto queued capacity", async () => {
    const { plane, messages } = readyRollbackPlane();
    loseSessionAfterValidation(plane, "s", () => {
      claimUnackedOnWorktree(plane, "claimed", "w2");
    });
    await expectFailedReplace(plane, ["w", "w2"]);
    expect(plane.getSession("claimed")).toMatchObject({
      status: "running",
      worktreeId: "cap-w",
      hostId: "cap",
    });
    expect(messages).toEqual([
      {
        hostId: "cap",
        message: expect.objectContaining({
          type: "session:assign",
          sessionId: "claimed",
          worktreeId: "cap-w",
        }),
      },
    ]);
  });

  it("does not assign when fail-closed rollback requeues nothing", async () => {
    const { plane, messages } = readyRollbackPlane();
    loseSessionAfterValidation(plane, "s", () => {
      const cancelled = {
        ...durableRunning("cancelled-wt", "w2"),
        status: "cancelled" as const,
        completedAt: "2026-01-01T00:00:00.000Z",
      };
      delete cancelled.ackReceivedAt;
      plane.state.sessions.set("cancelled-wt", cancelled);
      plane.state.worktrees.set("w2", durableWorktree("w2", "cancelled-wt"));
      plane.state.worktrees.set("w-idle", {
        ...durableWorktree("w-idle", null),
        status: "idle",
      });
    });
    await expectFailedReplace(plane, ["w", "w2", "w-idle"]);
    expect(plane.getSession("claimed")).toMatchObject({ status: "queued" });
    expect(plane.getSession("claimed")?.hostId ?? null).toBeNull();
    expect(plane.getSession("claimed")?.worktreeId ?? null).toBeNull();
    expect(messages).toEqual([]);
    expect(plane.state.sessions.get("cancelled-wt")).toMatchObject({
      status: "cancelled",
      worktreeId: null,
      hostId: null,
    });
    expect(plane.state.worktrees.has("w2")).toBe(false);
    expect(plane.state.worktrees.has("w-idle")).toBe(false);
  });
});
