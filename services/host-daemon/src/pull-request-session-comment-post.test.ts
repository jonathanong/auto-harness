import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { parseGitHubAppConfig } from "./github-app.ts";
import { LogStreamer } from "./log-streamer.ts";
import { postPullRequestSessionComment } from "./pull-request-session-comment-post.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();

function linesFor(): { streamer: LogStreamer; lines: string[] } {
  const lines: string[] = [];
  const streamer = new LogStreamer("sess-1", "attempt-1", () => undefined);
  const original = streamer.write.bind(streamer);
  streamer.write = (stream, content) => {
    lines.push(content);
    return original(stream, content);
  };
  return { streamer, lines };
}

function failing(message: string): ProcessRunner {
  return {
    async run() {
      throw new Error(message);
    },
  };
}

function remote(stdout: string): ProcessRunner {
  return {
    async run(opts) {
      opts.onChunk({ stream: "stdout", data: stdout });
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
}

describe("pull request comment failures", () => {
  it("skips assignments that are not pull requests", async () => {
    const { streamer, lines } = linesFor();
    await postPullRequestSessionComment({
      assign: baseAssign(),
      cwd: "/wt",
      streamer,
      childEnv: {},
      apiUrl: "https://harness.example.com",
      processRunner: failing("should not run"),
    });
    expect(lines).toEqual([]);
  });

  it("skips an unusable session link", async () => {
    const { streamer, lines } = linesFor();
    await postPullRequestSessionComment({
      assign: baseAssign({ sessionId: "not-a-session", metadata: { publishTargetPrNumber: 8 } }),
      cwd: "/wt",
      streamer,
      childEnv: {},
      apiUrl: "https://harness.example.com",
      processRunner: failing("should not run"),
    });
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { publishTargetPrNumber: "4" } }),
      cwd: "/wt",
      streamer,
      childEnv: {},
      apiUrl: "wss://harness.example.com/ws",
      processRunner: failing("should not run"),
    });
    expect(lines).toEqual([
      "Skipping pull request comment: session link is unavailable",
      "Skipping pull request comment: session link is unavailable",
    ]);
  });

  it("skips a non-github origin and a capped comment scan", async () => {
    const { streamer, lines } = linesFor();
    await postPullRequestSessionComment({
      assign: baseAssign({ ref: "refs/pull/3/head" }),
      cwd: "/wt",
      streamer,
      childEnv: { HOME: "/home/host", PATH: "/usr/bin" },
      apiUrl: "https://harness.example.com",
      processRunner: remote("https://example.com/acme/widgets.git\n"),
    });
    let pages = 0;
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { githubPullRequestNumber: 3 } }),
      cwd: "/wt",
      streamer,
      childEnv: { HOME: "/home/host", PATH: "/usr/bin" },
      apiUrl: "https://harness.example.com",
      processRunner: {
        async run(opts) {
          const data = opts.argv[0] === "git" ? "git@github.com:acme/widgets.git\n" : "0\n100\n";
          if (opts.argv[1] === "api") pages += 1;
          opts.onChunk({ stream: "stdout", data });
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect(pages).toBe(3);
    expect(lines).toEqual([
      "Skipping pull request comment: origin is not a github.com repository",
      "Skipping pull request comment: comment lookup reached its page limit",
    ]);
  });

  it("logs lookup, timeout, and overflow failures without failing the caller", async () => {
    const { streamer, lines } = linesFor();
    const input = {
      assign: baseAssign({ metadata: { publishTargetPrNumber: "9" } }),
      cwd: "/wt",
      streamer,
      childEnv: { HOME: "/home/host", PATH: "/usr/bin" },
      apiUrl: "https://harness.example.com",
    };
    await postPullRequestSessionComment({
      ...input,
      processRunner: {
        async run(opts) {
          if (opts.argv[0] === "git") {
            opts.onChunk({ stream: "stdout", data: "git@github.com:acme/widgets.git\n" });
            return { exitCode: 0, timedOut: false, signal: null };
          }
          opts.onChunk({ stream: "stdout", data: "nope\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    await postPullRequestSessionComment({
      ...input,
      processRunner: {
        async run() {
          return { exitCode: null, timedOut: true, signal: "SIGTERM" };
        },
      },
    });
    await postPullRequestSessionComment({
      ...input,
      processRunner: {
        async run(opts) {
          opts.onChunk({ stream: "stdout", data: "x".repeat(9_000) });
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect(lines.map((line) => line.replace(/:.*/, ""))).toEqual([
      "Could not comment on the pull request",
      "Could not comment on the pull request",
      "Could not comment on the pull request",
    ]);
  });

  it("stays quiet when the session is cancelled", async () => {
    const { streamer, lines } = linesFor();
    const signal = AbortSignal.abort();
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { publishTargetPrNumber: "9" } }),
      cwd: "/wt",
      streamer,
      childEnv: {},
      apiUrl: "https://harness.example.com",
      signal,
      processRunner: {
        async run() {
          return { exitCode: null, timedOut: false, cancelled: true, signal: null };
        },
      },
    });
    expect(lines).toEqual([]);
  });

  it("does not use ambient credentials when installation-token minting fails", async () => {
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
    const { streamer, lines } = linesFor();
    let spawned = false;
    await postPullRequestSessionComment({
      assign: baseAssign({ metadata: { publishTargetPrNumber: "9" } }),
      cwd: "/wt",
      streamer,
      childEnv: { HOME: "/home/host", PATH: "/usr/bin" },
      apiUrl: "https://harness.example.com",
      githubApp,
      fetchFn: vi.fn(async () => new Response("no", { status: 500 })),
      processRunner: {
        async run() {
          spawned = true;
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect(spawned).toBe(false);
    expect(lines[0]).toContain("GitHub App token request failed");
  });
});
