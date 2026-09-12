/* eslint-disable max-lines -- token setup, expiry, cancellation, and environment isolation share one fixture. */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGitHubAppConfig } from "./github-app.ts";
import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const now = Date.parse("2026-09-12T00:00:00.000Z");

function app() {
  return parseGitHubAppConfig(
    {
      appId: "1",
      privateKeyPath: "/keys/app.pem",
      botLogin: "auto-harness[bot]",
      botUserId: 2,
      repositories: { "repo-1": { installationId: 3, repositoryId: 4 } },
    },
    () => pem,
  );
}

function installTokenFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token: "ghs_exact-token",
          expires_at: "2026-09-12T01:00:00.000Z",
          permissions: {
            contents: "write",
            pull_requests: "write",
            issues: "write",
            metadata: "read",
          },
          repositories: [{ id: 4 }],
        }),
        { status: 201 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("claimed session GitHub App credentials", () => {
  it("injects a fresh token after bot identity configuration, clamps expiry, and redacts output", async () => {
    const fetchMock = installTokenFetch();
    const calls: string[][] = [];
    const systemRunner: ProcessRunner = {
      async run(options) {
        calls.push(options.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    let commandEnv: NodeJS.ProcessEnv | undefined;
    let commandTimeout: number | undefined;
    const commandRunner: ProcessRunner = {
      async run(options) {
        commandEnv = options.env;
        commandTimeout = options.timeoutMs;
        options.onChunk({ stream: "stdout", data: "token=ghs_exact-token" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs = [];
    const result = await runClaimedSession(
      systemRunner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      claimed,
      undefined,
      () => false,
      () => 4_000_000,
      commandRunner,
      {
        PATH: process.env.PATH,
        HOME: "/home/harness",
        GH_TOKEN: "ambient-gh",
        GITHUB_TOKEN: "ambient-github",
        GH_ENTERPRISE_TOKEN: "ambient-ghes",
        GITHUB_ENTERPRISE_TOKEN: "ambient-github-enterprise",
      },
      undefined,
      undefined,
      app(),
      () => now,
    );
    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(calls.map((argv) => argv.slice(-4))).toEqual([
      ["config", "--local", "user.name", "auto-harness[bot]"],
      ["config", "--local", "user.email", "2+auto-harness[bot]@users.noreply.github.com"],
    ]);
    expect(commandEnv?.GH_TOKEN).toBe("ghs_exact-token");
    expect(commandEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(commandEnv?.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(commandEnv?.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(commandTimeout).toBe(3_300_000);
    expect(logs.map((chunk) => chunk.content).join("")).toContain("token=[redacted]");
    expect(logs.map((chunk) => chunk.content).join("")).not.toContain("ghs_exact-token");
  });

  it.each([
    { timeout: false, status: "cancelled" },
    { timeout: true, status: "timed_out" },
  ] as const)(
    "preserves a $status outcome when provisioning is aborted",
    async ({ timeout, status }) => {
      const controller = new AbortController();
      vi.stubGlobal("fetch", async () => {
        controller.abort();
        throw new Error("aborted while minting");
      });
      const runner: ProcessRunner = {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      };
      const logs = [];
      await expect(
        runClaimedSession(
          runner,
          new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
          logs,
          baseAssign(),
          claimed,
          controller.signal,
          () => timeout,
          () => 4_000_000,
          runner,
          { PATH: process.env.PATH },
          undefined,
          undefined,
          app(),
          () => now,
        ),
      ).resolves.toMatchObject({ status });
    },
  );

  it("mints a new token for a native resume and fails closed without exposing a response body", async () => {
    const fetchMock = installTokenFetch();
    const systemRunner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const commandRunner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    for (const resume of [false, true]) {
      const logs = [];
      await expect(
        runClaimedSession(
          systemRunner,
          new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
          logs,
          baseAssign({ resume }),
          claimed,
          undefined,
          () => false,
          () => 4_000_000,
          commandRunner,
          { PATH: process.env.PATH },
          undefined,
          undefined,
          app(),
          () => now,
        ),
      ).resolves.toMatchObject({ status: "completed" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not inject or clamp when no App config is present", async () => {
    let options: { env?: NodeJS.ProcessEnv; timeoutMs: number } | undefined;
    const runner: ProcessRunner = {
      async run(input) {
        options = input;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs = [];
    await runClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      claimed,
      undefined,
      () => false,
      () => 123,
    );
    expect(options?.env?.GH_TOKEN).toBeUndefined();
    expect(options?.timeoutMs).toBe(123);
  });
});
