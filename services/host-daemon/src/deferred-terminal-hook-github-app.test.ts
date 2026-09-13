import { generateKeyPairSync } from "node:crypto";
import { stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createDeferredTerminalHookSettlement } from "./deferred-terminal-hook.ts";
import { parseGitHubAppConfig } from "./github-app.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function githubApp() {
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

describe("deferred terminal-hook mapped GitHub App recovery", () => {
  it("mints scoped App credentials for recovery, redacts hook failures, and removes its config", async () => {
    const token = "ghs_recovery-token";
    const now = Date.now();
    const expiresAt = new Date(now + 60 * 60_000).toISOString();
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
    const calls: Array<Parameters<import("./executor.ts").ProcessRunner["run"]>[0]> = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const settle = createDeferredTerminalHookSettlement({
      processRunner: {
        async run(options) {
          calls.push(options);
          if (options.argv[0] === "/bin/sh") throw new Error(`hook printed ${token}`);
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "session", repositoryId: "repo-1" } as never,
      claimed: {
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "/hook.sh" },
        }),
      },
      status: "failed",
      errorCode: undefined,
      childEnvSource: {
        PATH: process.env.PATH,
        GH_TOKEN: "ambient-gh",
        GITHUB_TOKEN: "ambient-github",
        GH_CONFIG_DIR: "/daemon-gh",
      },
      environmentIsChild: true,
      githubApp: githubApp(),
      nowMs: () => now,
    });

    try {
      await expect(settle(true, now + 10_000)).resolves.toEqual({
        summary: "Session failed",
        summarySource: "harness",
      });
      const hook = calls.find((options) => options.argv[0] === "/bin/sh");
      expect(hook?.env).toMatchObject({
        GH_TOKEN: token,
        GIT_AUTHOR_NAME: "auto-harness[bot]",
        GIT_AUTHOR_EMAIL: "2+auto-harness[bot]@users.noreply.github.com",
      });
      expect(hook?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(hook?.env?.GH_CONFIG_DIR).not.toBe("/daemon-gh");
      expect(hook?.timeoutMs).toBeLessThanOrEqual(10_000);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("[redacted]"));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining(token));
      await expect(stat(hook?.env?.GH_CONFIG_DIR ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      error.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
