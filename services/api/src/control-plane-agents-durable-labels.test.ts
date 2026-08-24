import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable registration label reconciliation", () => {
  it("keeps labels cleared by the UI when a stale daemon registration races the edit", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const previous = {
      hostId: "h",
      version: 4,
      updatedAt: "old",
      repositories: [
        {
          id: "r",
          path: "/r",
          defaultBranch: "main",
          worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
        },
      ],
      providerAccounts: [],
      capabilities: [],
    };
    let published: string[] | undefined;
    let stored: string[] | undefined;
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => previous,
      getWorktree: async () => null,
      putWorktreeFenced: async (worktree: { labels: string[] }) => {
        published = worktree.labels;
        return true;
      },
      listWorktreesByHost: async () => [],
      putHostInventoryFenced: async (next: typeof previous) => {
        stored = next.repositories[0]!.worktrees[0]!.labels;
        return { ok: true };
      },
    } as never;
    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: ["stale"] }],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).resolves.toEqual({ ok: true, connectionId: "c" });
    expect(published).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("publishes a changed daemon label snapshot to durable worktree rows", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const previous = {
      hostId: "h",
      version: 4,
      updatedAt: "old",
      repositories: [
        {
          id: "r",
          path: "/r",
          defaultBranch: "main",
          worktrees: [{ id: "w", name: "w", path: "/w", labels: ["old"], daemonLabels: ["old"] }],
        },
      ],
      providerAccounts: [],
      capabilities: [],
    };
    let published: string[] | undefined;
    let stored: string[] | undefined;
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => previous,
      getWorktree: async () => null,
      putWorktreeFenced: async (worktree: { labels: string[] }) => {
        published = worktree.labels;
        return true;
      },
      listWorktreesByHost: async () => [],
      putHostInventoryFenced: async (next: typeof previous) => {
        stored = next.repositories[0]!.worktrees[0]!.labels;
        return { ok: true };
      },
    } as never;
    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: ["new"] }],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).resolves.toEqual({ ok: true, connectionId: "c" });
    expect(published).toEqual(["new"]);
    expect(stored).toEqual(["new"]);
  });
});
