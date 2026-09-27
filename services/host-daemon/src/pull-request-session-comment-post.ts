import { thrownMessage } from "@auto-harness/shared";
import type { SessionAssign } from "@auto-harness/shared";

import { httpBaseFromApiUrl } from "./bootstrap.ts";
import { createChildEnv } from "./child-env.ts";
import type { ProcessRunner } from "./executor.ts";
import { mintInstallationToken, type GitHubAppConfig } from "./github-app.ts";
import type { LogStreamer } from "./log-streamer.ts";
import {
  githubRepositorySlug,
  pullRequestNumberFromAssign,
  sessionCommentBody,
  sessionCommentMarker,
} from "./pull-request-session-comment.ts";

const COMMENT_TIMEOUT_MS = 20_000;
const MAX_COMMENT_PAGES = 3;
const COMMENTS_PER_PAGE = 100;
const MAX_CAPTURE_BYTES = 8_192;
const SESSION_ID = /^sess-[A-Za-z0-9-]{1,80}$/u;

export type PullRequestCommentInput = {
  assign: SessionAssign;
  cwd: string;
  processRunner: ProcessRunner;
  streamer: LogStreamer;
  childEnv: NodeJS.ProcessEnv;
  apiUrl?: string;
  githubApp?: GitHubAppConfig;
  nowMs?: () => number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
};

/** Post one session-link comment when this run targets an existing pull request. */
export async function postPullRequestSessionComment(input: PullRequestCommentInput): Promise<void> {
  const pullRequest = pullRequestNumberFromAssign(input.assign);
  if (pullRequest === undefined) return;
  const sessionUrl = sessionUrlFor(input.apiUrl, input.assign.sessionId);
  if (!sessionUrl) {
    input.streamer.write("system", "Skipping pull request comment: session link is unavailable");
    return;
  }

  try {
    const token = await installationToken(input);
    if (token === null) return;
    const env = createChildEnv(input.childEnv);
    if (token) env.GH_TOKEN = token;
    const remote = await capture(input, env, ["git", "remote", "get-url", "origin"]);
    const slug = githubRepositorySlug(remote);
    if (!slug) {
      input.streamer.write(
        "system",
        "Skipping pull request comment: origin is not a github.com repository",
      );
      return;
    }
    const marker = sessionCommentMarker(input.assign.sessionId);
    const scan = await scanForMarker(input, env, slug, pullRequest, marker);
    if (scan === "present") {
      input.streamer.write(
        "system",
        `Pull request #${String(pullRequest)} already links this session`,
      );
      return;
    }
    if (scan === "capped") {
      input.streamer.write(
        "system",
        "Skipping pull request comment: comment lookup reached its page limit",
      );
      return;
    }
    await capture(input, env, [
      "gh",
      "pr",
      "comment",
      String(pullRequest),
      "--repo",
      `${slug.owner}/${slug.repo}`,
      "--body",
      sessionCommentBody(sessionUrl, input.assign.sessionId),
    ]);
    input.streamer.write("system", `Commented on pull request #${String(pullRequest)}`);
  } catch (error) {
    if (input.signal?.aborted) return;
    input.streamer.write(
      "system",
      `Could not comment on the pull request: ${thrownMessage(error)}`,
    );
  }
}

function sessionUrlFor(apiUrl: string | undefined, sessionId: string): string | undefined {
  if (!apiUrl || !SESSION_ID.test(sessionId)) return undefined;
  try {
    return `${httpBaseFromApiUrl(apiUrl)}/sessions/${sessionId}`;
  } catch {
    return undefined;
  }
}

/** `null` means minting failed and ambient credentials must not be used. */
async function installationToken(
  input: PullRequestCommentInput,
): Promise<string | null | undefined> {
  if (!input.githubApp || !input.assign.repositoryId) return undefined;
  try {
    const minted = await mintInstallationToken(
      input.githubApp,
      input.assign.repositoryId,
      input.signal,
      input.fetchFn,
      input.nowMs,
    );
    return minted?.token;
  } catch (error) {
    if (input.signal?.aborted) return null;
    input.streamer.write(
      "system",
      `Could not comment on the pull request: ${thrownMessage(error)}`,
    );
    return null;
  }
}

async function scanForMarker(
  input: PullRequestCommentInput,
  env: NodeJS.ProcessEnv,
  slug: { owner: string; repo: string },
  pullRequest: number,
  marker: string,
): Promise<"present" | "absent" | "capped"> {
  const jq = `([.[] | select((.body // "") | contains(${JSON.stringify(marker)}))] | length), length`;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const stdout = await capture(input, env, [
      "gh",
      "api",
      `repos/${slug.owner}/${slug.repo}/issues/${String(pullRequest)}/comments?per_page=${String(COMMENTS_PER_PAGE)}&page=${String(page)}`,
      "--jq",
      jq,
    ]);
    const [matches, total] = stdout
      .trim()
      .split(/\s+/u)
      .map((value) => Number(value));
    if (!Number.isInteger(matches) || !Number.isInteger(total) || matches! < 0 || total! < 0) {
      throw new Error("pull request comment lookup returned an unexpected count");
    }
    if (matches! > 0) return "present";
    if (total! < COMMENTS_PER_PAGE) return "absent";
  }
  return "capped";
}

async function capture(
  input: PullRequestCommentInput,
  env: NodeJS.ProcessEnv,
  argv: string[],
): Promise<string> {
  let stdout = "";
  const result = await input.processRunner.run({
    argv,
    cwd: input.cwd,
    env,
    timeoutMs: COMMENT_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    onChunk: (chunk) => {
      if (chunk.stream !== "stdout") return;
      if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) return;
      stdout += chunk.data;
    },
  });
  if (result.cancelled || input.signal?.aborted) throw new Error("cancelled");
  if (result.timedOut) throw new Error("pull request comment command timed out");
  if (result.exitCode !== 0)
    throw new Error(`${argv[0] ?? "command"} exited ${String(result.exitCode)}`);
  if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) {
    throw new Error("pull request comment output exceeded 8192 bytes");
  }
  return stdout;
}
