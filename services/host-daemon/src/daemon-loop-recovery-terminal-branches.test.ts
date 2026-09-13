import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { GITHUB_APP_TOKEN_MARGIN_MS, parseGitHubAppConfig } from "./github-app.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = key.export({ format: "pem", type: "pkcs1" }).toString();

function app() {
  return parseGitHubAppConfig(
    {
      appId: "1",
      privateKeyPath: "/key",
      botLogin: "auto-harness[bot]",
      botUserId: 2,
      repositories: { demo: { installationId: 3, repositoryId: 4 } },
    },
    () => pem,
  );
}

function tokenResponse(expiresAt: string): Response {
  return new Response(
    JSON.stringify({
      token: "ghs_recovery-terminal",
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
  );
}

type Internals = {
  runTerminalHookForClaim(message: object, claim: object, expiry: number): Promise<unknown>;
};

function message(repositoryId = "demo") {
  return {
    type: "session:terminal-hook" as const,
    handoffId: "recovery",
    sessionId: "session-recovery",
    repositoryId,
    worktreeId: "wt-1",
    status: "failed" as const,
  };
}

describe("DaemonLoop terminal recovery credential branches", () => {
  it("aborts credential provisioning when the handoff expiry is already reached", async () => {
    const { config, cleanup } = await makeRepo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse("2099-01-01T00:00:00.000Z")),
    );
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
        githubApp: app(),
      });
      const result = await (loop as unknown as Internals).runTerminalHookForClaim(
        message(),
        {
          currentHookTarget: async () => ({
            cwd: config.repositories[0]!.path,
            repository: {},
          }),
        },
        Date.now() - 1,
      );
      expect(result).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });

  it("fails closed when a mapped recovery target changes during hook setup", async () => {
    const { config, cleanup } = await makeRepo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse("2099-01-01T00:00:00.000Z")),
    );
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
        githubApp: app(),
        processRunner: { run: vi.fn(async () => ({ exitCode: 0, timedOut: false })) },
      });
      const result = await (loop as unknown as Internals).runTerminalHookForClaim(
        message(),
        {
          currentHookTarget: async () => ({
            cwd: config.repositories[0]!.path,
            repository: { terminalHookScript: "/hook.sh" },
            get allowedRoots(): readonly string[] {
              throw new Error("target changed");
            },
          }),
        },
        Date.now() + GITHUB_APP_TOKEN_MARGIN_MS + 60_000,
      );
      expect(result).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });
});
