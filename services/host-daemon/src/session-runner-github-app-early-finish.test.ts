import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { withoutAmbientGitHubTokens, type GitHubAppConfig } from "./github-app.ts";
import { SessionRunner } from "./session-runner.ts";
import type { WorktreeManager } from "./worktree-manager.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const tokenNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const childEnvSource = {
  PATH: "/bin",
  HARNESS_CHILD_ENV_ALLOWLIST: `${tokenNames.join(",")},PATH`,
  GH_TOKEN: "ambient-gh",
  GITHUB_TOKEN: "ambient-github",
  GH_ENTERPRISE_TOKEN: "ambient-ghes",
  GITHUB_ENTERPRISE_TOKEN: "ambient-github-enterprise",
};

const githubApp = {
  appId: "1",
  privateKey: null,
  botLogin: "auto-harness[bot]",
  botUserId: 1,
  repositories: new Map([["repo-1", { installationId: 1, repositoryId: 1 }]]),
} as unknown as GitHubAppConfig;

function runner(prepareCheckout: (signal: AbortSignal) => Promise<void>): {
  value: SessionRunner;
  hookEnvironments: NodeJS.ProcessEnv[];
} {
  const hookEnvironments: NodeJS.ProcessEnv[] = [];
  const processRunner: ProcessRunner = {
    async run(options) {
      if (options.argv[0] === "/bin/sh" && options.argv[1] === "/hook.sh") {
        hookEnvironments.push(options.env ?? {});
      }
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
  const worktrees = {
    claim: () => ({
      repository: {
        id: "repo-1",
        path: "/repo",
        defaultBranch: "main",
        terminalHookScript: "/hook.sh",
        worktrees: [],
      },
      worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
      cwd: "/wt",
      currentHookTarget: async () => ({
        cwd: "/wt",
        repository: { terminalHookScript: "/hook.sh" },
      }),
    }),
    prepareCheckout: (_claimed: unknown, _ref: unknown, signal: AbortSignal) =>
      prepareCheckout(signal),
    release: () => undefined,
  } as unknown as WorktreeManager;
  return {
    hookEnvironments,
    value: new SessionRunner({ worktrees, processRunner, childEnvSource, githubApp }),
  };
}

function expectScrubbed(environments: NodeJS.ProcessEnv[]) {
  expect(environments).toHaveLength(1);
  for (const name of tokenNames) expect(environments[0]?.[name]).toBeUndefined();
  expect(environments[0]?.PATH).toBe("/bin");
  expect(environments[0]?.HARNESS_CHILD_ENV_ALLOWLIST).toBeUndefined();
  expect(childEnvSource.GH_TOKEN).toBe("ambient-gh");
}

describe("SessionRunner mapped GitHub App early finishes", () => {
  it("cleans token names from the copied child allowlist", () => {
    expect(withoutAmbientGitHubTokens(childEnvSource)).toMatchObject({
      PATH: "/bin",
      HARNESS_CHILD_ENV_ALLOWLIST: "PATH",
    });
    expect(childEnvSource.GH_TOKEN).toBe("ambient-gh");
  });

  it("scrubs terminal hooks when cancellation wins before checkout", async () => {
    const test = runner(async () => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(
      test.value.run(baseAssign(), { signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expectScrubbed(test.hookEnvironments);
  });

  it("scrubs terminal hooks after a checkout failure", async () => {
    const test = runner(async () => {
      throw new Error("bad ref");
    });
    await expect(test.value.run(baseAssign())).resolves.toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
    });
    expectScrubbed(test.hookEnvironments);
  });

  it("scrubs terminal hooks after claimed-session execution rejects", async () => {
    const test = runner(async () => undefined);
    await expect(test.value.run(baseAssign())).resolves.toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
    });
    expectScrubbed(test.hookEnvironments);
  });
});
