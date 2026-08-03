import { describe, expect, it } from "vitest";

import {
  addHostWorktree,
  defaultWorktreePath,
  emptyHostInventory,
  mergeHostRepository,
  removeHostRepository,
  removeHostWorktree,
  updateHostWorktree,
  upsertHostRepository,
} from "./host-inventory.ts";

describe("host-inventory", () => {
  it("builds default worktree path as a suggestion only", () => {
    expect(defaultWorktreePath("/repo/", "wt-1")).toBe("/repo/.worktrees/wt-1");
  });

  it("emptyHostInventory seeds echo-prompt with no repos", () => {
    const inv = emptyHostInventory();
    expect(inv.repositories).toEqual([]);
    expect(inv.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
  });

  it("upsertHostRepository creates repo with empty worktrees", () => {
    const next = upsertHostRepository(null, {
      id: "demo",
      path: "/Users/jong/filaments",
      defaultBranch: "main",
    });
    expect(next.repositories).toHaveLength(1);
    expect(next.repositories[0]?.worktrees).toEqual([]);
    expect(next.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
  });

  it("upsertHostRepository preserves worktrees when path changes", () => {
    let inv = upsertHostRepository(null, {
      id: "demo",
      path: "/a",
      defaultBranch: "main",
    });
    inv = addHostWorktree(inv, "demo", {
      id: "runner",
      path: "/a/runner",
      labels: ["echo"],
    });
    inv = upsertHostRepository(inv, {
      id: "demo",
      path: "/b",
      defaultBranch: "main",
    });
    expect(inv.repositories[0]?.path).toBe("/b");
    expect(inv.repositories[0]?.worktrees).toEqual([
      { id: "runner", path: "/a/runner", labels: ["echo"] },
    ]);
  });

  it("addHostWorktree appends; rejects unknown repo and duplicate id", () => {
    const base = upsertHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
    });
    const withWt = addHostWorktree(base, "demo", {
      id: "wt-a",
      path: "/repo/wt-a",
      labels: [],
    });
    expect(withWt.repositories[0]?.worktrees).toHaveLength(1);
    expect(() => addHostWorktree(withWt, "missing", { id: "x", path: "/x", labels: [] })).toThrow(
      /Unknown repository/,
    );
    expect(() =>
      addHostWorktree(withWt, "demo", { id: "wt-a", path: "/other", labels: [] }),
    ).toThrow(/already exists/);
  });

  it("updateHostWorktree and removeHostWorktree", () => {
    let inv = upsertHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
    });
    inv = addHostWorktree(inv, "demo", {
      id: "wt-a",
      path: "/repo/wt-a",
      labels: ["a"],
    });
    inv = updateHostWorktree(inv, "demo", {
      id: "wt-a",
      path: "/repo/wt-a2",
      labels: ["b"],
    });
    expect(inv.repositories[0]?.worktrees[0]).toEqual({
      id: "wt-a",
      path: "/repo/wt-a2",
      labels: ["b"],
    });
    inv = removeHostWorktree(inv, "demo", "wt-a");
    expect(inv.repositories[0]?.worktrees).toEqual([]);
    expect(() => updateHostWorktree(inv, "missing", { id: "x", path: "/x", labels: [] })).toThrow(
      /Unknown repository/,
    );
    expect(() => updateHostWorktree(inv, "demo", { id: "nope", path: "/x", labels: [] })).toThrow(
      /Unknown worktree/,
    );
    expect(() => removeHostWorktree(inv, "missing", "x")).toThrow(/Unknown repository/);
  });

  it("removeHostRepository drops the repo", () => {
    let inv = upsertHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
    });
    inv = removeHostRepository(inv, "demo");
    expect(inv.repositories).toEqual([]);
  });

  it("legacy mergeHostRepository still forces a single worktree", () => {
    const next = mergeHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
      worktreeId: "wt-1",
    });
    expect(next.repositories[0]?.worktrees[0]?.path).toBe("/repo/.worktrees/wt-1");
  });
});
