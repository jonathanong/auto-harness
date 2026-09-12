import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const state = vi.hoisted(() => ({ failNextDirectoryCreation: false, failNextRemoval: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: vi.fn(async (...args: Parameters<typeof actual.mkdtemp>) => {
      if (state.failNextDirectoryCreation) {
        state.failNextDirectoryCreation = false;
        throw new Error("GitHub config directory cannot be created");
      }
      return actual.mkdtemp(...args);
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (state.failNextRemoval) {
        state.failNextRemoval = false;
        throw new Error("GitHub config directory is busy");
      }
      return actual.rm(...args);
    }),
  };
});

import type { ProcessRunner } from "./executor.ts";
import { parseGitHubAppConfig } from "./github-app.ts";
import { SessionRunner } from "./session-runner.ts";
import type { WorktreeManager } from "./worktree-manager.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const githubApp = parseGitHubAppConfig(
  {
    appId: "1",
    privateKeyPath: "/keys/app.pem",
    botLogin: "auto-harness[bot]",
    botUserId: 1,
    repositories: { "repo-1": { installationId: 1, repositoryId: 1 } },
  },
  () => pem,
);

function worktrees(prepareCheckout: () => Promise<void>): WorktreeManager {
  return {
    claim: () => ({
      repository: {
        id: "repo-1",
        path: "/repo",
        defaultBranch: "main",
        worktrees: [],
      },
      worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
      cwd: "/wt",
      currentHookTarget: async () => ({
        cwd: "/wt",
        repository: {},
      }),
    }),
    prepareCheckout,
    release: () => undefined,
  } as unknown as WorktreeManager;
}

afterEach(() => {
  state.failNextDirectoryCreation = false;
  state.failNextRemoval = false;
  vi.unstubAllGlobals();
});

describe("SessionRunner GitHub App cleanup", () => {
  it("returns setup_failed when isolated config creation fails", async () => {
    const runner: ProcessRunner = {
      async run() {
        throw new Error("must not spawn");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.failNextDirectoryCreation = true;
    state.failNextRemoval = true;

    const result = await new SessionRunner({
      worktrees: worktrees(async () => undefined),
      processRunner: runner,
      childEnvSource: { PATH: "/bin" },
      githubApp,
      now: () => "2026-08-01T00:00:00.000Z",
    }).run(baseAssign());

    expect(result).toMatchObject({
      status: "failed",
      exitCode: null,
      errorCode: "setup_failed",
      errorMessage: "GitHub config directory cannot be created",
    });
    expect(result.logs.map((chunk) => chunk.content)).toEqual([
      "Session started at 2026-08-01T00:00:00.000Z",
      "GitHub config directory cannot be created",
      "Session failed at 2026-08-01T00:00:00.000Z",
    ]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("does not discard the terminal result when isolated config cleanup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: "ghs_cleanup-token",
              expires_at: "2026-09-12T01:00:00.000Z",
              permissions: { contents: "write", pull_requests: "write", issues: "write" },
              repositories: [{ id: 1 }],
            }),
          ),
      ),
    );
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.failNextRemoval = true;

    const result = await new SessionRunner({
      worktrees: worktrees(async () => undefined),
      processRunner: runner,
      childEnvSource: { PATH: "/bin" },
      githubApp,
      nowMs: () => Date.parse("2026-09-12T00:00:00.000Z"),
    }).run(baseAssign());

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(error).toHaveBeenCalledWith(
      "failed to remove isolated GitHub config directory",
      expect.any(Error),
    );
    error.mockRestore();
  });
});
