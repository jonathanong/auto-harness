import { describe, expect, it } from "vitest";

import { defaultWorktreePath, mergeHostRepository } from "./host-inventory.ts";

describe("host-inventory", () => {
  it("builds default worktree path", () => {
    expect(defaultWorktreePath("/repo/", "wt-1")).toBe("/repo/.worktrees/wt-1");
  });

  it("merges a host repo and seeds echo-prompt when empty", () => {
    const next = mergeHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
      worktreeId: "wt-1",
    });
    expect(next.repositories).toHaveLength(1);
    expect(next.repositories[0]?.worktrees[0]?.path).toBe("/repo/.worktrees/wt-1");
    expect(next.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
  });

  it("replaces same id and keeps other profiles", () => {
    const first = mergeHostRepository(null, {
      id: "demo",
      path: "/a",
      defaultBranch: "main",
      worktreeId: "wt-1",
    });
    first.commandProfiles["codex"] = { argv: ["codex"], appendPrompt: true };
    const second = mergeHostRepository(first, {
      id: "demo",
      path: "/b",
      defaultBranch: "main",
      worktreeId: "wt-2",
    });
    expect(second.repositories).toHaveLength(1);
    expect(second.repositories[0]?.path).toBe("/b");
    expect(second.commandProfiles["codex"]?.argv).toEqual(["codex"]);
  });
});
