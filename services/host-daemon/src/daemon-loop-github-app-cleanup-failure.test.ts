import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rm: vi.fn(async () => {
      throw new Error("cleanup unavailable");
    }),
  };
});

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { parseGitHubAppConfig } from "./github-app.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

describe("DaemonLoop GitHub App cleanup", () => {
  it("logs an isolated config cleanup failure after a mapped hook", async () => {
    const { config, cleanup } = await makeRepo();
    const logs: string[] = [];
    let credentialDeadline!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: "ghs_test",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
            {
              status: 201,
            },
          ),
      ),
    );
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        onLog: (line) => logs.push(line),
        timers: {
          setTimeout: (callback) => {
            credentialDeadline = callback;
            return 1 as never;
          },
          clearTimeout: () => undefined,
        },
        githubApp: parseGitHubAppConfig(
          {
            appId: "1",
            privateKeyPath: "/keys/app.pem",
            botLogin: "auto-harness[bot]",
            botUserId: 2,
            repositories: { demo: { installationId: 3, repositoryId: 4 } },
          },
          () => pem,
        ),
        processRunner: {
          async run(options) {
            if (options.argv[0] === "/bin/sh")
              return { exitCode: 0, timedOut: false, signal: null };
            return { exitCode: 1, timedOut: false, signal: null };
          },
        },
      });
      await (
        loop as unknown as {
          runTerminalHookForClaim(
            message: object,
            claim: object,
            expiresAtMs: number,
          ): Promise<unknown>;
        }
      ).runTerminalHookForClaim(
        {
          type: "session:terminal-hook",
          handoffId: "cleanup",
          sessionId: "cleanup",
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
      credentialDeadline();
      expect(logs).toContainEqual(
        expect.stringContaining("failed to remove isolated GitHub config directory"),
      );
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });
});
