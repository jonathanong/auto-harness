import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import * as assignment from "./request-assignment.ts";

function durableRunning(id: string, worktreeId: string) {
  return {
    id,
    repositoryId: "r",
    prompt: "p",
    targetLabel: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue" as const,
    status: "running" as const,
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId,
    ackReceivedAt: "t",
    primaryCommandStartState: "pending" as const,
    reconnectDeadlineAt: "2000-01-01T00:00:00.000Z",
  };
}

function loseSessionAfterValidation(plane: ControlPlane, sessionId: string, onLost?: () => void) {
  let reads = 0;
  const origGet = plane.state.sessions.get.bind(plane.state.sessions);
  plane.state.sessions.get = (id: string) => {
    const current = origGet(id);
    if (id !== sessionId || !current) return current;
    reads += 1;
    if (reads > 1) onLost?.();
    return reads === 1 ? current : { ...current, status: "queued" as const };
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storage-less register rollback assignment with a newer owner", () => {
  it("requests assignment when a newer owner drops a replacement-only unacked worktree", async () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      connectionIdFactory: (() => {
        let id = 0;
        return () => `c${++id}`;
      })(),
    });
    expect(
      plane.registerHost({
        hostId: "h",
        worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }],
        commandProfiles: [],
      }),
    ).toEqual({ ok: true, connectionId: "c1" });
    plane.state.sessions.set("s", { ...durableRunning("s", "w") });
    plane.state.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "r",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "s",
    });
    loseSessionAfterValidation(plane, "s", () => {
      plane.state.connections.set("winner", {
        connectionId: "winner",
        type: "host",
        hostId: "h",
        connectedAt: "2026-01-01T00:00:00.000Z",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
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
      const claimed = { ...durableRunning("claimed", "w2") };
      delete claimed.ackReceivedAt;
      plane.state.sessions.set("claimed", claimed);
      plane.state.worktrees.set("w2", {
        id: "w2",
        name: "w2",
        hostId: "h",
        repositoryId: "r",
        path: "/w2",
        labels: [],
        status: "busy",
        online: true,
        currentSessionId: "claimed",
      });
    });
    const request = vi.spyOn(assignment, "requestAssignment").mockResolvedValue(undefined);
    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [
          { id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] },
          { id: "w2", name: "w2", repositoryId: "r", path: "/w2", labels: [] },
        ],
        commandProfiles: [],
        runningSessions: ["s"],
        replaceExisting: true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "reported running session lost reconnect reconciliation",
    });
    expect(plane.state.sessions.get("claimed")).toMatchObject({
      status: "queued",
      worktreeId: null,
      hostId: null,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(plane.state);
  });
});
