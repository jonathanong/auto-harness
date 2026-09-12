import { generateKeyPairSync } from "node:crypto";
import { stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { parseGitHubAppConfig } from "./github-app.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function githubApp() {
  return parseGitHubAppConfig(
    {
      appId: "1",
      privateKeyPath: "/keys/app.pem",
      botLogin: "auto-harness[bot]",
      botUserId: 2,
      repositories: { demo: { installationId: 3, repositoryId: 4 } },
    },
    () => pem,
  );
}

type HandoffInternals = {
  runTerminalHookForClaim(message: object, claim: object, expiresAtMs: number): Promise<unknown>;
};

describe("DaemonLoop mapped GitHub App recovery", () => {
  it("runs a mapped replacement hook and probes with fresh scoped App credentials", async () => {
    const { config, cleanup } = await makeRepo();
    const token = "ghs_replacement-token";
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token,
              expires_at: expiresAt,
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
      ),
    );
    const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv; timeoutMs: number }> = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        githubApp: githubApp(),
        childEnvSource: {
          PATH: process.env.PATH,
          GH_TOKEN: "ambient-gh",
          GITHUB_TOKEN: "ambient-github",
          GH_CONFIG_DIR: "/daemon-gh",
        },
        processRunner: {
          async run(options) {
            calls.push(options);
            if (options.argv[0] === "/bin/sh") throw new Error(`hook printed ${token}`);
            return { exitCode: 1, timedOut: false, signal: null };
          },
        },
      });
      const result = await (loop as unknown as HandoffInternals).runTerminalHookForClaim(
        {
          type: "session:terminal-hook",
          handoffId: "replacement",
          sessionId: "lost",
          repositoryId: "demo",
          worktreeId: "wt-1",
          status: "failed",
          expiresAt: new Date(Date.now() + 10_000).toISOString(),
        },
        {
          currentHookTarget: async () => ({
            cwd: config.repositories[0]!.path,
            repository: { ...config.repositories[0]!, terminalHookScript: "/hook.sh" },
          }),
        },
        Date.now() + 10_000,
      );

      expect(result).toEqual({ summary: "Session failed", summarySource: "harness" });
      const hook = calls.find((call) => call.argv[0] === "/bin/sh");
      const probe = calls.find((call) => call.argv[0] !== "/bin/sh");
      expect(hook?.env).toMatchObject({
        GH_TOKEN: token,
        GIT_AUTHOR_NAME: "auto-harness[bot]",
        GIT_AUTHOR_EMAIL: "2+auto-harness[bot]@users.noreply.github.com",
      });
      expect(probe?.env?.GH_TOKEN).toBe(token);
      expect(hook?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(hook?.env?.GH_CONFIG_DIR).not.toBe("/daemon-gh");
      expect(hook?.timeoutMs).toBeLessThanOrEqual(10_000);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("[redacted]"));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining(token));
      await expect(stat(hook?.env?.GH_CONFIG_DIR ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      error.mockRestore();
      vi.unstubAllGlobals();
      cleanup();
    }
  });
});
