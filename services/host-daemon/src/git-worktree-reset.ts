import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import { gitFailure, runGit } from "./git-commands.ts";

const MAX_UPDATE_INDEX_PATHS = 128;
const MAX_UPDATE_INDEX_PATH_CHARACTERS = 8_000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function hasMarker(gitDir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await pathExists(resolve(gitDir, name))) return true;
  }
  return false;
}

async function quitOperation(
  runner: ProcessRunner,
  cwd: string,
  gitDir: string,
  markers: readonly string[],
  commands: readonly (readonly string[])[],
  signal?: AbortSignal,
): Promise<void> {
  if (!(await hasMarker(gitDir, markers))) return;
  for (const command of commands) {
    await runGit(runner, cwd, [...command], signal);
    if (!(await hasMarker(gitDir, markers))) return;
  }
  throw new Error("Failed to clear interrupted Git operation");
}

async function clearInterruptedOperations(
  runner: ProcessRunner,
  cwd: string,
  gitDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await quitOperation(runner, cwd, gitDir, ["rebase-merge"], [["rebase", "--abort"]], signal);
  await quitOperation(
    runner,
    cwd,
    gitDir,
    ["rebase-apply"],
    [
      ["rebase", "--abort"],
      ["am", "--abort"],
    ],
    signal,
  );
  await quitOperation(runner, cwd, gitDir, ["MERGE_HEAD"], [["merge", "--abort"]], signal);
  await quitOperation(
    runner,
    cwd,
    gitDir,
    ["CHERRY_PICK_HEAD", "sequencer"],
    [["cherry-pick", "--abort"]],
    signal,
  );
  await quitOperation(runner, cwd, gitDir, ["REVERT_HEAD"], [["revert", "--abort"]], signal);
}

function trackedPathChunks(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let characters = 0;
  for (const path of paths) {
    if (
      chunk.length > 0 &&
      (chunk.length >= MAX_UPDATE_INDEX_PATHS ||
        characters + path.length > MAX_UPDATE_INDEX_PATH_CHARACTERS)
    ) {
      chunks.push(chunk);
      chunk = [];
      characters = 0;
    }
    chunk.push(path);
    characters += path.length;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

async function clearTrackedPathFlags(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const listed = await runGit(runner, cwd, ["ls-files", "-z"], signal);
  if (listed.exitCode !== 0) throw gitFailure("Failed to inspect tracked files", listed.stderr);
  const paths = listed.stdout.split("\0");
  if (paths.at(-1) === "") paths.pop();
  for (const chunk of trackedPathChunks(paths)) {
    for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"]) {
      const updated = await runGit(runner, cwd, ["update-index", flag, "--", ...chunk], signal);
      if (updated.exitCode !== 0) {
        throw gitFailure("Failed to clear tracked-file index flags", updated.stderr);
      }
    }
  }
}

export async function resetPriorWorktreeState(
  runner: ProcessRunner,
  cwd: string,
  gitDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await clearInterruptedOperations(runner, cwd, gitDir, signal);
  await clearTrackedPathFlags(runner, cwd, signal);
}
