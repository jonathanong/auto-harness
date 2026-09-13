/* eslint-disable max-lines -- recovery, index hygiene, and isolated reset share one boundary. */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import { gitFailure, MAX_CAPTURED_GIT_STDOUT_BYTES, runGit } from "./git-commands.ts";

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
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!(await hasMarker(gitDir, markers))) return;
  for (const command of commands) {
    await runGit(runner, cwd, [...command], signal, environment);
    if (!(await hasMarker(gitDir, markers))) return;
  }
  throw new Error("Failed to clear interrupted Git operation");
}

async function clearInterruptedOperations(
  runner: ProcessRunner,
  cwd: string,
  gitDir: string,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  await quitOperation(
    runner,
    cwd,
    gitDir,
    ["rebase-merge"],
    [["rebase", "--abort"]],
    signal,
    environment,
  );
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
    environment,
  );
  await quitOperation(
    runner,
    cwd,
    gitDir,
    ["MERGE_HEAD"],
    [["merge", "--abort"]],
    signal,
    environment,
  );
  await quitOperation(
    runner,
    cwd,
    gitDir,
    ["CHERRY_PICK_HEAD", "sequencer"],
    [["cherry-pick", "--abort"]],
    signal,
    environment,
  );
  await quitOperation(
    runner,
    cwd,
    gitDir,
    ["REVERT_HEAD"],
    [["revert", "--abort"]],
    signal,
    environment,
  );
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

function flaggedTrackedPaths(output: string): {
  assumeUnchanged: string[];
  skipWorktree: string[];
} {
  const assumeUnchanged: string[] = [];
  const skipWorktree: string[] = [];
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  for (const record of records) {
    if (record.length < 3 || record[1] !== " ") {
      throw new Error("Failed to parse tracked-file index flags");
    }
    const tag = record[0]!;
    const path = record.slice(2);
    if (tag >= "a" && tag <= "z") assumeUnchanged.push(path);
    if (tag === "S" || tag === "s") skipWorktree.push(path);
  }
  return { assumeUnchanged, skipWorktree };
}

async function clearTrackedPathFlags(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  // `-v` adds a two-byte tag to each record. Doubling the ordinary capture bound preserves the
  // largest path-only listing accepted before flag inspection was added (a path is at least one
  // byte plus its NUL separator).
  const listed = await runGit(
    runner,
    cwd,
    ["ls-files", "-v", "-z"],
    signal,
    environment,
    undefined,
    MAX_CAPTURED_GIT_STDOUT_BYTES * 2,
  );
  if (listed.exitCode !== 0) throw gitFailure("Failed to inspect tracked files", listed.stderr);
  const paths = flaggedTrackedPaths(listed.stdout);
  for (const [flag, flagged] of [
    ["--no-assume-unchanged", paths.assumeUnchanged],
    ["--no-skip-worktree", paths.skipWorktree],
  ] as const) {
    for (const chunk of trackedPathChunks(flagged)) {
      const updated = await runGit(
        runner,
        cwd,
        ["update-index", flag, "--", ...chunk],
        signal,
        environment,
      );
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
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  await clearInterruptedOperations(runner, cwd, gitDir, signal, environment);
  await clearTrackedPathFlags(runner, cwd, signal, environment);
}

export async function resetInitializedSubmodules(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const synced = await runGit(
    runner,
    cwd,
    ["submodule", "sync", "--recursive"],
    signal,
    environment,
  );
  if (synced.exitCode !== 0) throw gitFailure("Failed to sync submodules", synced.stderr);
  const updated = await runGit(
    runner,
    cwd,
    ["submodule", "update", "--recursive", "--checkout", "--force"],
    signal,
    environment,
  );
  if (updated.exitCode !== 0) throw gitFailure("Failed to update submodules", updated.stderr);
}
