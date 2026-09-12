import {
  MAX_SESSION_RESULT_FILES,
  MAX_SESSION_RESULT_FILE_BYTES,
  normalizeSessionResult,
  type SessionResult,
  type SessionTerminalStatus,
} from "@auto-harness/shared";

import { truncateUtf8, type ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";
import { resolveTrustedExecutable } from "./resolve-executable.ts";

const GH_CAPTURE_BYTES = 8 * 1024;
const GIT_PATH_CAPTURE_BYTES = MAX_SESSION_RESULT_FILES * (MAX_SESSION_RESULT_FILE_BYTES + 1);

type PathCapture = { exitCode: number; stdout: string; truncated: boolean };

function completePrefix(capture: PathCapture): string {
  return capture.truncated
    ? capture.stdout.slice(0, capture.stdout.lastIndexOf("\0") + 1)
    : capture.stdout;
}

/**
 * Capture just enough NUL-delimited path data for a bounded result. Unlike the
 * general git helper this deliberately keeps a complete prefix when its bound
 * is reached, so a noisy repository still returns useful facts with the
 * truncation marker instead of treating normal volume as probe failure.
 */
async function captureGitPaths(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<PathCapture> {
  let stdout = "";
  let truncated = false;
  const result = await runner.run({
    argv: [resolveTrustedExecutable("git", environment), ...args],
    cwd,
    env: environment,
    timeoutMs: 120_000,
    preserveOutputChunks: true,
    onChunk: (chunk) => {
      if (chunk.stream !== "stdout") return;
      const remaining = GIT_PATH_CAPTURE_BYTES - Buffer.byteLength(stdout, "utf8");
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (Buffer.byteLength(chunk.data, "utf8") > remaining) truncated = true;
      stdout += truncateUtf8(chunk.data, remaining);
    },
  });
  return { exitCode: result.exitCode ?? 1, stdout, truncated };
}

function pathsFromNul(value: string): { paths: string[]; truncated: boolean } {
  let truncated = false;
  const paths: string[] = [];
  for (const path of value.split("\0")) {
    if (!path) continue;
    if (Buffer.byteLength(path, "utf8") > MAX_SESSION_RESULT_FILE_BYTES) {
      truncated = true;
      continue;
    }
    paths.push(path);
  }
  return { paths, truncated };
}

async function branchFor(
  runner: ProcessRunner,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const result = await runGit(
      runner,
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      undefined,
      environment,
    );
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function changedFiles(
  runner: ProcessRunner,
  cwd: string,
  baseline: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ filesChanged?: string[]; filesChangedTruncated?: true }> {
  try {
    const [diff, untracked] = await Promise.all([
      captureGitPaths(runner, cwd, ["diff", "--name-only", "-z", baseline, "--"], environment),
      captureGitPaths(
        runner,
        cwd,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        environment,
      ),
    ]);
    if (diff.exitCode !== 0 || untracked.exitCode !== 0) return {};
    // A capped read can end mid-filename. Remove that fragment before parsing;
    // a partial path must never become a false changed-file fact.
    const changed = pathsFromNul(completePrefix(diff));
    const untrackedPaths = pathsFromNul(completePrefix(untracked));
    const all = [...new Set([...changed.paths, ...untrackedPaths.paths])].toSorted();
    return {
      filesChanged: all.slice(0, MAX_SESSION_RESULT_FILES),
      ...(diff.truncated ||
      untracked.truncated ||
      changed.truncated ||
      untrackedPaths.truncated ||
      all.length > MAX_SESSION_RESULT_FILES
        ? { filesChangedTruncated: true }
        : {}),
    };
  } catch {
    return {};
  }
}

async function pullRequestFor(
  runner: ProcessRunner,
  cwd: string,
  branch: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!branch) return undefined;
  try {
    let stdout = "";
    const result = await runner.run({
      argv: [
        resolveTrustedExecutable("gh", environment),
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "url",
        "--limit",
        "2",
      ],
      cwd,
      env: environment,
      timeoutMs: 5_000,
      preserveOutputChunks: true,
      onChunk: (chunk) => {
        if (chunk.stream === "stdout" && Buffer.byteLength(stdout, "utf8") < GH_CAPTURE_BYTES) {
          stdout += truncateUtf8(chunk.data, GH_CAPTURE_BYTES - Buffer.byteLength(stdout, "utf8"));
        }
      },
    });
    if (result.exitCode !== 0 || Buffer.byteLength(stdout, "utf8") >= GH_CAPTURE_BYTES)
      return undefined;
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    const url =
      parsed[0] && typeof parsed[0] === "object" ? (parsed[0] as { url?: unknown }).url : undefined;
    if (typeof url !== "string") return undefined;
    const candidate = new URL(url);
    return candidate.protocol === "http:" || candidate.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function harnessSummary(
  status: SessionTerminalStatus,
  branch: string | undefined,
  files: number | undefined,
  pr: string | undefined,
): string {
  const parts = [`Session ${status}`];
  if (branch) parts.push(`on ${branch}`);
  if (files !== undefined) parts.push(`${String(files)} file${files === 1 ? "" : "s"} changed`);
  if (pr) parts.push("pull request found");
  return parts.join("; ");
}

/** Best-effort post-hook result facts. Errors are deliberately represented by omitted fields. */
export async function collectSessionResult(options: {
  runner: ProcessRunner;
  cwd: string;
  status: SessionTerminalStatus;
  baseline?: string;
  agentSummary?: string;
  environment: NodeJS.ProcessEnv;
}): Promise<SessionResult> {
  const branch = await branchFor(options.runner, options.cwd, options.environment);
  const files = options.baseline
    ? await changedFiles(options.runner, options.cwd, options.baseline, options.environment)
    : {};
  const pullRequestUrl = await pullRequestFor(
    options.runner,
    options.cwd,
    branch,
    options.environment,
  );
  const result: SessionResult = options.agentSummary?.trim()
    ? { summary: options.agentSummary.trim(), summarySource: "agent" }
    : {
        summary: harnessSummary(options.status, branch, files.filesChanged?.length, pullRequestUrl),
        summarySource: "harness",
      };
  if (branch) result.branch = branch;
  if (files.filesChanged) result.filesChanged = files.filesChanged;
  if (files.filesChangedTruncated) result.filesChangedTruncated = true;
  if (pullRequestUrl) result.pullRequestUrl = pullRequestUrl;
  return normalizeSessionResult(result)!;
}
