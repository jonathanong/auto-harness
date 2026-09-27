import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { parseGitHubAppConfig } from "./github-app.ts";
import { LogStreamer } from "./log-streamer.ts";
import { postPullRequestSessionComment } from "./pull-request-session-comment-post.ts";
import {
  githubRepositorySlug,
  pullRequestNumberFromAssign,
  sessionCommentBody,
} from "./pull-request-session-comment.ts";
import { baseAssign, setup } from "../test-helpers/session-runner-test-helpers.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function logsOf(streamer: LogStreamer): string[] {
  const lines: string[] = [];
  const original = streamer.write.bind(streamer);
  streamer.write = (stream, content) => {
    lines.push(content);
    return original(stream, content);
  };
  return lines;
}

function runner(handler: ProcessRunner["run"]): ProcessRunner {
  return { run: handler };
}

describe("pull request session comments", () => {
  it("reads a pull request number from metadata or a pull ref", () => {
    expect(pullRequestNumberFromAssign({ metadata: { publishTargetPrNumber: "888" } })).toBe(888);
    expect(pullRequestNumberFromAssign({ metadata: { githubPullRequestNumber: 19 } })).toBe(19);
    expect(
      pullRequestNumberFromAssign({
        metadata: { githubPullRequestNumber: null },
        ref: "refs/pull/7/head",
      }),
    ).toBe(7);
    expect(
      pullRequestNumberFromAssign({ metadata: { publishTargetPrNumber: "0" } }),
    ).toBeUndefined();
    expect(pullRequestNumberFromAssign({ ref: "refs/heads/main" })).toBeUndefined();
  });

  it("accepts github.com remotes only", () => {
    expect(githubRepositorySlug("git@github.com:acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(githubRepositorySlug("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(githubRepositorySlug("ssh://git@github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(githubRepositorySlug("https://user:token@github.com/acme/widgets.git")).toBeUndefined();
    expect(githubRepositorySlug("git@gitlab.com:acme/widgets.git")).toBeUndefined();
  });

  it("posts one session link and skips a repeat", async () => {
    const calls: string[][] = [];
    const streamer = new LogStreamer("sess-1", "attempt-1", () => undefined);
    const lines = logsOf(streamer);
    const seen = new Set<string>();
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { publishTargetPrNumber: "888" } }),
      cwd: "/wt",
      streamer,
      childEnv: { PATH: "/usr/bin", HOME: "/home/host" },
      apiUrl: "https://harness.example.com",
      processRunner: runner(async (opts) => {
        calls.push(opts.argv);
        if (opts.argv[0] === "git") {
          opts.onChunk({ stream: "stdout", data: "git@github.com:acme/widgets.git\n" });
        } else if (opts.argv[1] === "api") {
          const marker = "<!-- auto-harness-session:sess-1 -->";
          opts.onChunk({
            stream: "stdout",
            data: seen.has(marker) ? "1\n1\n" : "0\n1\n",
          });
        } else if (opts.argv[2] === "comment") {
          expect(opts.argv[7]).toBe(
            sessionCommentBody("https://harness.example.com/sessions/sess-1", "sess-1"),
          );
          seen.add("<!-- auto-harness-session:sess-1 -->");
        }
        return { exitCode: 0, timedOut: false, signal: null };
      }),
    });
    expect(lines).toEqual(["Commented on pull request #888"]);
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { publishTargetPrNumber: "888" } }),
      cwd: "/wt",
      streamer,
      childEnv: { PATH: "/usr/bin", HOME: "/home/host" },
      apiUrl: "https://harness.example.com",
      processRunner: runner(async (opts) => {
        calls.push(opts.argv);
        if (opts.argv[0] === "git") {
          opts.onChunk({ stream: "stdout", data: "git@github.com:acme/widgets.git\n" });
        } else {
          opts.onChunk({ stream: "stdout", data: "1\n1\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      }),
    });
    expect(lines.at(-1)).toBe("Pull request #888 already links this session");
    expect(calls.some((argv) => argv[2] === "comment")).toBe(true);
    expect(calls.filter((argv) => argv[2] === "comment")).toHaveLength(1);
  });

  it("does not fail the session when the comment cannot be posted", async () => {
    const streamer = new LogStreamer("sess-1", "attempt-1", () => undefined);
    const lines = logsOf(streamer);
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { githubPullRequestNumber: 4 } }),
      cwd: "/wt",
      streamer,
      childEnv: {},
      apiUrl: "https://harness.example.com",
      processRunner: runner(async () => ({ exitCode: 1, timedOut: false, signal: null })),
    });
    expect(lines[0]).toContain("Could not comment on the pull request:");
  });

  it("uses the installation token for a mapped repository and does not fall back", async () => {
    const githubApp = parseGitHubAppConfig(
      {
        appId: "123",
        privateKeyPath: "/keys/app.pem",
        botLogin: "auto-harness[bot]",
        botUserId: 456,
        repositories: { "repo-1": { installationId: 789, repositoryId: 101_112 } },
      },
      () => pem,
    );
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "ghs_exact-token",
            expires_at: "2026-09-12T01:00:00.000Z",
            permissions: { contents: "write", pull_requests: "write", issues: "write" },
            repositories: [{ id: 101_112 }],
          }),
          { status: 201 },
        ),
    );
    let token: string | undefined;
    await postPullRequestSessionComment({
      assign: baseAssign({ ref: "refs/pull/12/head" }),
      cwd: "/wt",
      streamer: new LogStreamer("sess-1", "attempt-1", () => undefined),
      childEnv: { PATH: "/usr/bin", HOME: "/home/host" },
      apiUrl: "https://harness.example.com",
      githubApp,
      fetchFn,
      nowMs: () => 0,
      processRunner: runner(async (opts) => {
        token = opts.env?.GH_TOKEN;
        if (opts.argv[0] === "git") {
          opts.onChunk({ stream: "stdout", data: "https://github.com/acme/widgets.git\n" });
        } else if (opts.argv[1] === "api") {
          opts.onChunk({ stream: "stdout", data: "0\n0\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      }),
    });
    expect(token).toBe("ghs_exact-token");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("comments from the session runner after checkout", async () => {
    const { sessionRunner } = setup(
      {
        async run(opts) {
          if (opts.argv[0] === "git") {
            opts.onChunk({ stream: "stdout", data: "git@github.com:acme/widgets.git\n" });
          } else if (opts.argv[1] === "api") {
            opts.onChunk({ stream: "stdout", data: "0\n1\n" });
          }
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      {},
      { identity: { apiUrl: "https://harness.example.com" } },
    );
    const result = await sessionRunner.run(
      baseAssign({ metadata: { publishTargetPrNumber: "888" } }),
    );
    expect(result.logs.map((chunk) => chunk.content)).toContain("Commented on pull request #888");
  });
});
