import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failRemove: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      if (state.failRemove) throw new Error("config busy");
    }),
  };
});

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { createDeferredTerminalHookSettlement } from "./deferred-terminal-hook.ts";
import { parseGitHubAppConfig } from "./github-app.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = key.export({ format: "pem", type: "pkcs1" }).toString();
const token = "ghs_branch-token";
const app = (repositories: Record<string, { installationId: number; repositoryId: number }>) =>
  parseGitHubAppConfig(
    { appId: "1", privateKeyPath: "/key", botLogin: "bot", botUserId: 1, repositories },
    () => pem,
  );
const reply = (expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()) =>
  new Response(
    JSON.stringify({
      token,
      expires_at: expiresAt,
      permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
      repositories: [{ id: 4 }],
    }),
    { status: 201 },
  );
const resultRunner = {
  async run() {
    return { exitCode: 1, timedOut: false, signal: null };
  },
};

describe("GitHub App recovery failure branches", () => {
  it("keeps an unmapped deferred no-hook recovery ambient and probes normally", async () => {
    const run = vi.fn(resultRunner.run);
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "s", repositoryId: "other" } as never,
      claimed: { currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }) },
      status: "failed",
      errorCode: undefined,
      childEnvSource: { PATH: process.env.PATH, GH_TOKEN: "ambient" },
      environmentIsChild: true,
      githubApp: app({ "repo-1": { installationId: 3, repositoryId: 4 } }),
    });
    await expect(settle(true)).resolves.toMatchObject({ summarySource: "harness" });
    expect(run.mock.calls[0]?.[0].env?.GH_TOKEN).toBe("ambient");
  });

  it("fails closed on deferred mint failure and reports isolated-config cleanup errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const run = vi.fn(resultRunner.run);
    const write = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.failRemove = true;
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write } as never,
      assign: { sessionId: "s", repositoryId: "repo-1" } as never,
      claimed: { currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }) },
      status: "failed",
      errorCode: undefined,
      childEnvSource: { PATH: process.env.PATH },
      environmentIsChild: true,
      githubApp: app({ "repo-1": { installationId: 3, repositoryId: 4 } }),
    });
    try {
      await expect(settle(true)).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith("system", "GitHub App credential provisioning failed");
      expect(error).toHaveBeenCalledWith(
        "failed to remove isolated GitHub config directory",
        expect.any(Error),
      );
    } finally {
      state.failRemove = false;
      error.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not fall back to daemon credentials when replacement minting fails", async () => {
    const { config, cleanup } = await makeRepo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const logs: string[] = [];
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport(),
      githubApp: app({ demo: { installationId: 3, repositoryId: 4 } }),
      onLog: (line) => logs.push(line),
      processRunner: resultRunner,
    });
    const run = (
      loop as unknown as {
        runTerminalHookForClaim(message: object, claim: object, expiry: number): Promise<unknown>;
      }
    ).runTerminalHookForClaim.bind(loop);
    try {
      await expect(
        run(
          { sessionId: "s", repositoryId: "demo", status: "failed" },
          { currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }) },
          Date.now() + 10_000,
        ),
      ).resolves.toBeUndefined();
      expect(logs).toContain("GitHub App credential provisioning failed for s");
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });

  it("uses normal child sanitization for an unmapped replacement without a hook", async () => {
    const { config, cleanup } = await makeRepo();
    const run = vi.fn(resultRunner.run);
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport(),
      childEnvSource: { PATH: process.env.PATH, GH_TOKEN: "ambient" },
      processRunner: { run },
    });
    const recovery = (
      loop as unknown as {
        runTerminalHookForClaim(message: object, claim: object, expiry: number): Promise<unknown>;
      }
    ).runTerminalHookForClaim.bind(loop);
    try {
      await expect(
        recovery(
          { sessionId: "s", repositoryId: "demo", status: "failed" },
          { currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }) },
          Date.now() + 10_000,
        ),
      ).resolves.toMatchObject({ summarySource: "harness" });
      expect(run.mock.calls[0]?.[0].env?.GH_TOKEN).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("abandons an already-expired replacement lease after a valid mint", async () => {
    const { config, cleanup } = await makeRepo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply()),
    );
    const run = vi.fn(resultRunner.run);
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport(),
      githubApp: app({ demo: { installationId: 3, repositoryId: 4 } }),
      processRunner: { run },
    });
    const recovery = (
      loop as unknown as {
        runTerminalHookForClaim(message: object, claim: object, expiry: number): Promise<unknown>;
      }
    ).runTerminalHookForClaim.bind(loop);
    try {
      await expect(
        recovery(
          { sessionId: "s", repositoryId: "demo", status: "failed" },
          { currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }) },
          Date.now() - 1,
        ),
      ).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });
});
