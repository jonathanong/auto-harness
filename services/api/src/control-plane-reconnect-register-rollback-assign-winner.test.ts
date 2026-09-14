import { describe, expect, it } from "vitest";

import {
  claimUnackedOnWorktree,
  expectFailedReplace,
  installUnpublishedWinner,
  loseSessionAfterValidation,
  readyRollbackPlane,
  ROLLBACK_NOW,
} from "../test-helpers/control-plane-register-rollback-test-helpers.ts";

describe("storage-less register rollback assignment with a newer owner", () => {
  it("assigns when a newer owner drops a replacement-only unacked worktree", async () => {
    const { plane, messages } = readyRollbackPlane();
    loseSessionAfterValidation(plane, "s", () => {
      plane.state.connections.set("winner", {
        connectionId: "winner",
        type: "host",
        hostId: "h",
        connectedAt: ROLLBACK_NOW,
        lastHeartbeatAt: ROLLBACK_NOW,
        repositoryIds: ["r"],
        capabilities: [],
        negotiatedProtocolVersion: 1,
      });
      plane.state.hostConnection.set("h", "winner");
      const inventory = plane.state.hostInventories.get("h");
      if (inventory) {
        plane.state.hostInventories.set("h", {
          ...inventory,
          repositories: inventory.repositories.map((repo) => ({
            ...repo,
            worktrees: repo.worktrees.filter((wt) => wt.id === "w"),
          })),
        });
      }
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

  it("defers assignment while the winning socket is unpublished", async () => {
    const { plane, messages } = readyRollbackPlane();
    loseSessionAfterValidation(plane, "s", () => {
      installUnpublishedWinner(plane, "winner", "w-idle");
      claimUnackedOnWorktree(plane, "claimed", "w2");
    });
    await expectFailedReplace(plane, ["w", "w2"]);
    expect(plane.getSession("claimed")).toMatchObject({ status: "queued" });
    expect(plane.getSession("claimed")?.hostId ?? null).toBeNull();
    expect(messages).toEqual([]);
    const capConnectionId = plane.state.hostConnection.get("cap");
    if (capConnectionId) plane.disconnectHost(capConnectionId);
    plane.state.pendingHostSocketPublish.delete("winner");
    await plane.requestAssignment();
    expect(plane.getSession("claimed")).toMatchObject({
      status: "running",
      hostId: "h",
      worktreeId: "w-idle",
    });
    expect(messages).toEqual([
      {
        hostId: "h",
        message: expect.objectContaining({
          type: "session:assign",
          sessionId: "claimed",
          worktreeId: "w-idle",
        }),
      },
    ]);
  });
});
