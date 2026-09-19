import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError } from "../src/cli/cli-errors.js";
import { parseWorktreeFlags } from "../src/cli/commands/parse-worktree-flag.js";

test("parses <id>=<path> pairs into worktree entries, name mirroring id", () => {
  const worktrees = parseWorktreeFlags(["wt-1=/repos/a/wt-1", "wt-2=/repos/a/wt-2"]);
  assert.deepEqual(worktrees, [
    { id: "wt-1", name: "wt-1", path: "/repos/a/wt-1", labels: [] },
    { id: "wt-2", name: "wt-2", path: "/repos/a/wt-2", labels: [] },
  ]);
});

test("an empty list of raw values parses to an empty array", () => {
  assert.deepEqual(parseWorktreeFlags([]), []);
});

test("splits on the first = only, so a path containing = still parses", () => {
  const worktrees = parseWorktreeFlags(["wt-1=/repos/a?x=1"]);
  assert.deepEqual(worktrees[0], { id: "wt-1", name: "wt-1", path: "/repos/a?x=1", labels: [] });
});

test("rejects a value with no =", () => {
  assert.throws(
    () => parseWorktreeFlags(["wt-1"]),
    (error) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--worktree must be <id>=<path>, got: wt-1/);
      return true;
    },
  );
});

test("rejects an empty id", () => {
  assert.throws(() => parseWorktreeFlags(["=/repos/a"]), CliUsageError);
});

test("rejects an empty path", () => {
  assert.throws(() => parseWorktreeFlags(["wt-1="]), CliUsageError);
});

test("rejects a repeated worktree id", () => {
  assert.throws(
    () => parseWorktreeFlags(["wt-1=/a", "wt-1=/b"]),
    (error) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--worktree id given more than once: wt-1/);
      return true;
    },
  );
});
