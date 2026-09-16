import { describe, expect, it } from "vitest";

import { mainCheckoutDirtyEntries } from "./git-main-checkout-status.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

describe("mainCheckoutDirtyEntries", () => {
  it("returns nothing for status output with no entries", async () => {
    // Defensive: `git status --porcelain -z` never emits a lone NUL in practice
    // (the outer caller only invokes this once stdout is non-empty), but the
    // parser must not fabricate an entry from it.
    const runner = { run: () => Promise.reject(new Error("no git call expected")) };
    await expect(mainCheckoutDirtyEntries(runner, "/repo", "\0")).resolves.toEqual([]);
  });

  it("skips the worktree-list lookup entirely when nothing is untracked", async () => {
    // A `scripted` runner throws on any unmatched call, so this also proves the
    // "worktree list" lookup is never made when there is no `??` entry to check.
    const runner = scripted([]);
    const dirty = await mainCheckoutDirtyEntries(runner, "/repo", " M tracked.txt\0", undefined);
    expect(dirty).toEqual([{ code: " M", path: "tracked.txt" }]);
  });

  it("tolerates a missing trailing NUL", async () => {
    const runner = scripted([]);
    const dirty = await mainCheckoutDirtyEntries(runner, "/repo", " M tracked.txt");
    expect(dirty).toEqual([{ code: " M", path: "tracked.txt" }]);
  });

  it("skips a rename's origin-path field instead of misreading it as its own entry", async () => {
    const runner = scripted([]);
    const dirty = await mainCheckoutDirtyEntries(
      runner,
      "/repo",
      "R  new.txt\0old.txt\0M  f.txt\0",
    );
    expect(dirty).toEqual([
      { code: "R ", path: "new.txt" },
      { code: "M ", path: "f.txt" },
    ]);
  });
});
