import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

function row(id: string, repositoryId: string) {
  return {
    id,
    name: id,
    hostId: "h",
    repositoryId,
    path: `/${repositoryId}/${id}`,
    labels: [],
    status: "idle" as const,
    online: true,
    currentSessionId: null,
    lastAssignedAt: null,
    connectionId: "old",
  };
}

describe("durable registration and retained repositories", () => {
  it("stamps worktrees of an unregistered repository offline", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const written: Array<{ id: string; online: boolean }> = [];
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => ({
        hostId: "h",
        version: 1,
        repositories: [
          { id: "a", path: "/a", defaultBranch: "main", worktrees: [] },
          { id: "b", path: "/b", defaultBranch: "main", worktrees: [] },
        ],
        providerAccounts: [],
        capabilities: [],
        updatedAt: "t",
      }),
      getWorktree: async () => null,
      listWorktreesByHost: async () => [row("a1", "a"), row("b1", "b")],
      listActiveSessionsByHost: async () => [],
      putHostInventoryFenced: async () => ({ ok: true as const }),
      putWorktreeFenced: async (next: { id: string; online: boolean }) => (
        written.push({ id: next.id, online: next.online }),
        true
      ),
      getHostLock: async () => null,
    } as never;

    await plane.registerHostDurable({
      hostId: "h",
      repositories: [{ id: "a", path: "/a" }],
      worktrees: [],
      replaceExisting: true,
    });

    expect(written).toEqual([
      { id: "a1", online: true },
      { id: "b1", online: false },
    ]);
  });
});
