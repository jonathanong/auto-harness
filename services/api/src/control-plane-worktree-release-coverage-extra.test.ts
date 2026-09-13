import { describe, expect, it, vi } from "vitest";

import { releaseWorktree } from "./control-plane-worktree-release.ts";
import { createControlPlaneState, settleStorage } from "./control-plane-state.ts";

const worktree = {
  id: "worktree",
  name: "worktree",
  hostId: "host",
  repositoryId: "repository",
  path: "/worktree",
  labels: [],
  status: "busy" as const,
  online: true,
  currentSessionId: "session",
};

describe("worktree release residual coverage", () => {
  it("does nothing for an already-removed worktree", () => {
    const state = createControlPlaneState();

    releaseWorktree(state, "missing");

    expect(state.worktrees).toEqual(new Map());
  });

  it("makes an ordinary released worktree idle and persists its cleared owner", async () => {
    const putWorktree = vi.fn(async () => undefined);
    const state = createControlPlaneState({ storage: { putWorktree } as never });
    state.worktrees.set(worktree.id, { ...worktree });

    releaseWorktree(state, worktree.id);
    await settleStorage(state);

    expect(state.worktrees.get(worktree.id)).toMatchObject({
      status: "idle",
      online: true,
      currentSessionId: null,
    });
    expect(putWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ status: "idle", online: true, currentSessionId: null }),
    );
  });

  it.each(["drainingHosts", "disconnectedHosts"] as const)(
    "keeps a %s worktree offline after release",
    (offlineSet) => {
      const state = createControlPlaneState();
      state.worktrees.set(worktree.id, { ...worktree });
      if (offlineSet === "drainingHosts") state.drainingHosts.add(worktree.hostId);
      else
        state.disconnectedHosts.set(worktree.hostId, { lastHeartbeatAt: "2026-01-01T00:00:00Z" });

      releaseWorktree(state, worktree.id);

      expect(state.worktrees.get(worktree.id)).toMatchObject({
        status: "idle",
        online: false,
        currentSessionId: null,
      });
    },
  );
});
