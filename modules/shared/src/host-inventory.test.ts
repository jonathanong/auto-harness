import { describe, expect, it } from "vitest";

import {
  addHostWorktree,
  defaultWorktreePath,
  emptyHostInventory,
  mergeHostRepository,
  removeHostRepository,
  removeHostWorktree,
  updateHostSetupScript,
  updateHostRequiredEnvironment,
  updateHostWorktree,
  upsertHostRepository,
} from "./host-inventory.ts";

describe("host-inventory", () => {
  it("builds default worktree path as a suggestion only", () => {
    expect(defaultWorktreePath("/repo/", "runner-1")).toBe("/repo/.worktrees/runner-1");
  });

  it("emptyHostInventory has no repos", () => {
    const inv = emptyHostInventory();
    expect(inv.repositories).toEqual([]);
    expect(inv.providerAccounts).toEqual([]);
  });

  it("updates and preserves the host-wide setup script", () => {
    let inv = updateHostSetupScript(null, "source ~/.zshrc");
    inv = upsertHostRepository(inv, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
    });
    expect(inv.setupScript).toBe("source ~/.zshrc");
  });

  it("adds and removes host-wide required environment names", () => {
    let inventory = updateHostRequiredEnvironment(null, ["TOKEN"]);
    expect(inventory.requiredEnvironment).toEqual(["TOKEN"]);
    inventory = updateHostRequiredEnvironment(inventory, []);
    expect(inventory).not.toHaveProperty("requiredEnvironment");
  });

  it("upsertHostRepository creates repo with empty worktrees", () => {
    const next = upsertHostRepository(null, {
      id: "demo",
      path: "/tmp/demo-repo",
      defaultBranch: "main",
    });
    expect(next.repositories).toHaveLength(1);
    expect(next.repositories[0]?.worktrees).toEqual([]);
  });

  it("upsertHostRepository preserves worktrees when path changes", () => {
    let inv = upsertHostRepository(null, {
      id: "demo",
      path: "/a",
      defaultBranch: "main",
    });
    inv = addHostWorktree(inv, "demo", {
      id: "runner",
      name: "runner",
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
      { id: "runner", name: "runner", path: "/a/runner", labels: ["echo"] },
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
      name: "wt-a",
      path: "/repo/wt-a",
      labels: [],
    });
    expect(withWt.repositories[0]?.worktrees).toHaveLength(1);
    expect(() =>
      addHostWorktree(withWt, "missing", { id: "x", name: "x", path: "/x", labels: [] }),
    ).toThrow(/Unknown repository/);
    expect(() =>
      addHostWorktree(withWt, "demo", { id: "wt-a", name: "wt-a", path: "/other", labels: [] }),
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
      name: "wt-a",
      path: "/repo/wt-a",
      labels: ["a"],
    });
    inv = updateHostWorktree(inv, "demo", {
      id: "wt-a",
      name: "wt-a2",
      path: "/repo/wt-a2",
      labels: ["b"],
    });
    expect(inv.repositories[0]?.worktrees[0]).toEqual({
      id: "wt-a",
      name: "wt-a2",
      path: "/repo/wt-a2",
      labels: ["b"],
    });
    inv = removeHostWorktree(inv, "demo", "wt-a");
    expect(inv.repositories[0]?.worktrees).toEqual([]);
    expect(() =>
      updateHostWorktree(inv, "missing", { id: "x", name: "x", path: "/x", labels: [] }),
    ).toThrow(/Unknown repository/);
    expect(() =>
      updateHostWorktree(inv, "demo", { id: "nope", name: "nope", path: "/x", labels: [] }),
    ).toThrow(/Unknown worktree/);
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
      worktreeName: "wt-1",
    });
    expect(next.repositories[0]?.worktrees[0]?.path).toBe("/repo/.worktrees/wt-1");
    expect(next.repositories[0]?.worktrees[0]?.labels).toEqual([]);
  });

  it("upsertHostRepository preserves scripts by default and allows overriding them", () => {
    let inv = upsertHostRepository(null, {
      id: "demo",
      path: "/a",
      defaultBranch: "main",
      setupScript: "npm install",
      terminalHookScript: "/hook.sh",
    });
    expect(inv.repositories[0]).toMatchObject({
      setupScript: "npm install",
      terminalHookScript: "/hook.sh",
    });
    // Re-upserting without scripts must not wipe the existing ones.
    inv = upsertHostRepository(inv, { id: "demo", path: "/b", defaultBranch: "main" });
    expect(inv.repositories[0]).toMatchObject({
      path: "/b",
      setupScript: "npm install",
      terminalHookScript: "/hook.sh",
    });
    // Explicit override replaces it.
    inv = upsertHostRepository(inv, {
      id: "demo",
      path: "/b",
      defaultBranch: "main",
      setupScript: "pnpm install",
    });
    expect(inv.repositories[0]?.setupScript).toBe("pnpm install");
    expect(inv.repositories[0]?.terminalHookScript).toBe("/hook.sh");
  });

  it("addHostWorktree and updateHostWorktree preserve setupScript", () => {
    let inv = upsertHostRepository(null, { id: "demo", path: "/repo", defaultBranch: "main" });
    inv = addHostWorktree(inv, "demo", {
      id: "wt-a",
      name: "wt-a",
      path: "/repo/wt-a",
      labels: [],
      setupScript: "npm ci",
    });
    expect(inv.repositories[0]?.worktrees[0]?.setupScript).toBe("npm ci");
    // Updating labels/path without setupScript must not wipe it.
    inv = updateHostWorktree(inv, "demo", {
      id: "wt-a",
      name: "wt-a",
      path: "/repo/wt-a2",
      labels: ["x"],
    });
    expect(inv.repositories[0]?.worktrees[0]).toMatchObject({
      path: "/repo/wt-a2",
      labels: ["x"],
      setupScript: "npm ci",
    });
    // Explicit override replaces it.
    inv = updateHostWorktree(inv, "demo", {
      id: "wt-a",
      name: "wt-a",
      path: "/repo/wt-a2",
      labels: ["x"],
      setupScript: "npm run setup",
    });
    expect(inv.repositories[0]?.worktrees[0]?.setupScript).toBe("npm run setup");
  });
});
