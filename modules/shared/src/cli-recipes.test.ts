import { describe, expect, it } from "vitest";

import {
  CLI_RECIPES,
  FALLBACK_WORKTREE_DIR,
  VENDOR_WORKTREE_DIRS,
  cliRecipeByProvider,
  vendorWorktreeDir,
  vendorWorktreeRootNames,
} from "./cli-recipes.ts";
import { defaultWorktreePath } from "./host-inventory.ts";

describe("cli-recipes vendor worktree dirs", () => {
  it("maps known labels to vendor dirs and falls back otherwise", () => {
    expect(vendorWorktreeDir(["claude"])).toBe(VENDOR_WORKTREE_DIRS.claude);
    expect(vendorWorktreeDir(["grok"])).toBe(VENDOR_WORKTREE_DIRS.grok);
    expect(vendorWorktreeDir(["cursor"])).toBe(VENDOR_WORKTREE_DIRS.cursor);
    expect(vendorWorktreeDir(["cursor-agent"])).toBe(VENDOR_WORKTREE_DIRS["cursor-agent"]);
    expect(vendorWorktreeDir(["codex"])).toBe(VENDOR_WORKTREE_DIRS.codex);
    expect(vendorWorktreeDir(["echo"])).toBe(FALLBACK_WORKTREE_DIR);
    expect(vendorWorktreeDir([])).toBe(FALLBACK_WORKTREE_DIR);
    expect(defaultWorktreePath("/repo", "wt-1", ["cursor-agent"])).toBe(
      "/repo/.cursor/worktrees/wt-1",
    );
    expect(vendorWorktreeRootNames()).toEqual([
      ".claude",
      ".codex",
      ".cursor",
      ".grok",
      ".worktrees",
    ]);
  });

  it("uses the first matching label", () => {
    expect(vendorWorktreeDir(["echo", "claude"])).toBe(VENDOR_WORKTREE_DIRS.claude);
    expect(vendorWorktreeDir(["claude", "codex"])).toBe(VENDOR_WORKTREE_DIRS.claude);
  });

  it("lists empirically verified print/exec recipes", () => {
    expect(cliRecipeByProvider("cursor-agent")?.argv).toEqual(["cursor-agent", "-p", "--trust"]);
    expect(cliRecipeByProvider("claude")?.argv).toEqual(["claude", "-p"]);
    expect(cliRecipeByProvider("codex")?.argv).toEqual(["codex", "exec"]);
    expect(cliRecipeByProvider("grok")?.argv).toEqual([
      "grok",
      "--always-approve",
      "--max-turns",
      "3",
      "--output-format",
      "plain",
      "-p",
    ]);
    expect(cliRecipeByProvider("missing")).toBeUndefined();
    expect(CLI_RECIPES.every((recipe) => recipe.appendPrompt)).toBe(true);
    expect(CLI_RECIPES.map((recipe) => recipe.providerName)).toEqual([
      "claude",
      "codex",
      "grok",
      "cursor-agent",
    ]);
  });
});
