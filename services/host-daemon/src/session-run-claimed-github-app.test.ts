/* eslint-disable max-lines -- token setup, expiry, cancellation, and environment isolation share one fixture. */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGitHubAppConfig } from "./github-app.ts";
import type { ProcessRunner } from "./executor.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
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
  it("injects a fresh token and session-scoped bot identity, clamps expiry, and redacts output", async () => {
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
    expect(calls).toEqual([]);
    expect(commandEnv?.GH_TOKEN).toBe("ghs_exact-token");
    expect(commandEnv?.GIT_AUTHOR_NAME).toBe("auto-harness[bot]");
    expect(commandEnv?.GIT_AUTHOR_EMAIL).toBe("2+auto-harness[bot]@users.noreply.github.com");
    expect(commandEnv?.GIT_COMMITTER_NAME).toBe("auto-harness[bot]");
    expect(commandEnv?.GIT_COMMITTER_EMAIL).toBe("2+auto-harness[bot]@users.noreply.github.com");
    expect(commandEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(commandEnv?.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(commandEnv?.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(commandTimeout).toBe(3_300_000);
    expect(logs.map((chunk) => chunk.content).join("")).toContain("token=[redacted]");
    expect(logs.map((chunk) => chunk.content).join("")).not.toContain("ghs_exact-token");
  });

  it("uses the scoped token for terminal hooks when the command runner rejects", async () => {
    installTokenFetch();
    let hookEnv: NodeJS.ProcessEnv | undefined;
    const systemRunner: ProcessRunner = {
      async run(options) {
        if (options.argv[0] === "/bin/sh" && options.argv[1] === "/hook.sh") {
          hookEnv = options.env;
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const commandRunner: ProcessRunner = {
      async run() {
        throw new Error("pty failed with ghs_exact-token");
      },
    };
    const logs = [];
    const result = await runClaimedSession(
      systemRunner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      {
        ...claimed,
        currentHookTarget: async () => ({
          cwd: claimed.cwd,
          repository: { terminalHookScript: "/hook.sh" },
        }),
      },
      undefined,
      () => false,
      () => 4_000_000,
      commandRunner,
      { PATH: process.env.PATH, HOME: "/home/harness" },
      undefined,
      undefined,
      app(),
      () => now,
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "setup_failed" });
    expect(hookEnv?.GH_TOKEN).toBe("ghs_exact-token");
    expect(hookEnv?.GIT_AUTHOR_NAME).toBe("auto-harness[bot]");
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

  it("scrubs ambient GitHub credentials before setup and again before the command", async () => {
    installTokenFetch();
    let setupEnv: NodeJS.ProcessEnv | undefined;
    let hookEnv: NodeJS.ProcessEnv | undefined;
    const systemRunner: ProcessRunner = {
      async run(options) {
        if (options.argv[0] === "/bin/sh" && options.argv[1] === "/hook.sh") {
          hookEnv = options.env;
          return { exitCode: 0, timedOut: false, signal: null };
        }
        setupEnv = options.env;
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          environment: {
            ...options.env,
            GH_TOKEN: "setup-gh",
            GITHUB_TOKEN: "setup-github",
          },
        };
      },
    };
    let commandEnv: NodeJS.ProcessEnv | undefined;
    const commandRunner: ProcessRunner = {
      async run(options) {
        commandEnv = options.env;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs = [];
    await expect(
      runClaimedSession(
        systemRunner,
        new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
        logs,
        baseAssign({ setupScript: "setup" }),
        {
          ...claimed,
          currentHookTarget: async () => ({
            cwd: claimed.cwd,
            repository: { terminalHookScript: "/hook.sh" },
          }),
        },
        undefined,
        () => false,
        () => 4_000_000,
        commandRunner,
        {
          PATH: process.env.PATH,
          HOME: "/home/harness",
          HARNESS_CHILD_ENV_ALLOWLIST:
            "GH_TOKEN,GITHUB_TOKEN,GH_ENTERPRISE_TOKEN,GITHUB_ENTERPRISE_TOKEN",
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github",
          GH_ENTERPRISE_TOKEN: "ambient-ghes",
          GITHUB_ENTERPRISE_TOKEN: "ambient-github-enterprise",
        },
        undefined,
        undefined,
        app(),
        () => now,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      expect(setupEnv?.[key]).toBeUndefined();
      if (key !== "GH_TOKEN") expect(hookEnv?.[key]).toBeUndefined();
    }
    expect(commandEnv?.GH_TOKEN).toBe("ghs_exact-token");
    expect(hookEnv?.GH_TOKEN).toBe("ghs_exact-token");
    expect(hookEnv?.GIT_AUTHOR_NAME).toBe("auto-harness[bot]");
    expect(commandEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(commandEnv?.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(commandEnv?.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it("preserves the isolated GitHub config directory through setup and profiles", async () => {
    installTokenFetch();
    const isolatedGitHubConfigDir = "/tmp/isolated-github-config";
    let commandEnv: NodeJS.ProcessEnv | undefined;
    let hookEnv: NodeJS.ProcessEnv | undefined;
    const systemRunner: ProcessRunner = {
      async run(options) {
        if (options.argv[0] === "/bin/sh" && options.argv[1] === "/hook.sh") {
          hookEnv = options.env;
          return { exitCode: 0, timedOut: false, signal: null };
        }
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          environment: { ...options.env },
        };
      },
    };
    const commandRunner: ProcessRunner = {
      async run(options) {
        commandEnv = options.env;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const executionProfiles: ExecutionProfiles = {
      maxConcurrentAssignments: 1,
      profiles: new Map([
        [
          "acct-1",
          { providerAccountId: "acct-1", home: "/tmp", env: { GH_CONFIG_DIR: "/profile-gh" } },
        ],
      ]),
    };
    const logs = [];
    await expect(
      runClaimedSession(
        systemRunner,
        new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
        logs,
        baseAssign({ providerAccountId: "acct-1", setupScript: "setup" }),
        {
          ...claimed,
          currentHookTarget: async () => ({
            cwd: claimed.cwd,
            repository: { terminalHookScript: "/hook.sh" },
          }),
        },
        undefined,
        () => false,
        () => 4_000_000,
        commandRunner,
        { PATH: process.env.PATH, GH_CONFIG_DIR: "/ambient-gh" },
        executionProfiles,
        undefined,
        app(),
        () => now,
        undefined,
        isolatedGitHubConfigDir,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(commandEnv?.GH_CONFIG_DIR).toBe(isolatedGitHubConfigDir);
    expect(hookEnv?.GH_CONFIG_DIR).toBe(isolatedGitHubConfigDir);
  });

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
    let setupEnv: NodeJS.ProcessEnv | undefined;
    let options: { env?: NodeJS.ProcessEnv; timeoutMs: number } | undefined;
    const systemRunner: ProcessRunner = {
      async run(input) {
        setupEnv = input.env;
        return { exitCode: 0, timedOut: false, signal: null, environment: input.env };
      },
    };
    const commandRunner: ProcessRunner = {
      async run(input) {
        options = input;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs = [];
    await runClaimedSession(
      systemRunner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign({ setupScript: "setup" }),
      claimed,
      undefined,
      () => false,
      () => 123,
      commandRunner,
      {
        PATH: process.env.PATH,
        HARNESS_CHILD_ENV_ALLOWLIST: "GH_TOKEN",
        GH_TOKEN: "ambient-gh",
      },
    );
    expect(setupEnv?.GH_TOKEN).toBe("ambient-gh");
    expect(options?.env?.GH_TOKEN).toBe("ambient-gh");
    expect(options?.timeoutMs).toBe(123);
  });
});
