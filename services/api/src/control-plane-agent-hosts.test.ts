import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("agent host inventory", () => {
  it("stores config and syncs worktrees", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putHostInventory("local-1", {
      hostId: "local-1",
      setupScript: "source ~/.zshrc",
      repositories: [
        {
          id: "demo",
          path: "/repo",
          defaultBranch: "main",
          setupScript: "true",
          terminalHookScript: "/hook",
          worktrees: [
            { id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["echo"], setupScript: "true" },
            { id: "wt-2", name: "wt-2", path: "/repo/wt-2", labels: [] },
          ],
        },
      ],
    });
    expect(put.ok).toBe(true);
    expect(plane.getHostInventory("local-1")?.setupScript).toBe("source ~/.zshrc");
    expect(plane.getHostInventory("local-1")?.repositories[0]?.path).toBe("/repo");
    expect(plane.listWorktrees().filter((w) => w.hostId === "local-1")).toHaveLength(2);
    expect(plane.listHostInventories()).toHaveLength(1);

    // Replace inventory: drop wt-2, keep wt-1
    const replace = plane.putHostInventory("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["echo"] }],
        },
      ],
    });
    expect(replace.ok).toBe(true);
    expect(plane.listWorktrees().map((w) => w.id)).toEqual(["wt-1"]);

    // Empty inventory is valid (add-agent / attach-repos-later).
    const empty = plane.putHostInventory("local-1", { repositories: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.config.repositories).toEqual([]);
    }
    // Offline host-only agent appears in fleet list.
    expect(plane.putHostInventory("slot-offline", { repositories: [] }).ok).toBe(true);
    const agents = plane.listHosts();
    const offline = agents.find((a) => a.hostId === "slot-offline");
    expect(offline).toMatchObject({
      hostId: "slot-offline",
      online: false,
      connectedAt: null,
      worktreeIds: [],
    });
    // Host for an already-listed agent is skipped in the offline-host merge loop.
    plane.registerHost({ hostId: "slot-offline", worktrees: [] });
    const afterReg = plane.listHosts().find((a) => a.hostId === "slot-offline");
    expect(afterReg?.online).toBe(true);
    expect(afterReg?.connectedAt).toBe("2026-01-01T00:00:00.000Z");
    // Offline host with worktrees exposes worktreeIds in the fleet list.
    expect(
      plane.putHostInventory("host-with-wts", {
        repositories: [
          {
            id: "r1",
            path: "/r",
            worktrees: [
              { id: "w1", name: "w1", path: "/r/w1", labels: [] },
              { id: "w2", name: "w2", path: "/r/w2", labels: ["echo"] },
            ],
          },
        ],
      }).ok,
    ).toBe(true);
    expect(plane.listHosts().find((a) => a.hostId === "host-with-wts")?.worktreeIds).toEqual([
      "w1",
      "w2",
    ]);
    // Still invalid: missing/non-array repositories, or a non-object body.
    expect(plane.putHostInventory("local-1", {}).ok).toBe(false);
    expect(plane.putHostInventory("local-1", { repositories: "x" }).ok).toBe(false);
    expect(plane.putHostInventory("local-1", null).ok).toBe(false);
    expect(plane.putHostInventory("local-1", { repositories: [], setupScript: 1 }).ok).toBe(false);
    expect(
      plane.putHostInventory("local-1", {
        hostId: "other",
        repositories: [
          { id: "d", path: "/r", worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [{ id: "d", path: "/r", worktrees: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          { id: "d", path: "/r", worktrees: [{ id: "w", name: "w", path: "/w", labels: "x" }] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [null] }],
      }).ok,
    ).toBe(false);
    expect(plane.putHostInventory("x", { repositories: [null] }).ok).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            setupScript: 1,
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            terminalHookScript: 1,
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [], setupScript: 1 }],
          },
        ],
      }).ok,
    ).toBe(false);

    expect(plane.deleteHostInventory("local-1").ok).toBe(true);
    expect(plane.getHostInventory("local-1")).toBeNull();
    expect(plane.deleteHostInventory("local-1").ok).toBe(false);
  });
});
