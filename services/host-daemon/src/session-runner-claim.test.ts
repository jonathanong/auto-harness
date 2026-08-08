import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign, setup } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

describe("SessionRunner claim and checkout failures", () => {
  it("fails claim for unknown worktree", async () => {
    const { sessionRunner } = setup({
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(baseAssign({ worktreeId: "missing" }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("setup_failed");
  });

  it("stringifies non-Error claim failures", async () => {
    const worktrees = {
      claim: () => {
        throw "claim-nope";
      },
      release: () => undefined,
      prepareCheckout: async () => undefined,
      ensureAll: async () => undefined,
      isBusy: () => false,
    } as unknown as WorktreeManager;
    const sessionRunner = new SessionRunner({
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const result = await sessionRunner.run(baseAssign());
    expect(result.errorMessage).toBe("claim-nope");
  });

  it("fails checkout errors as setup_failed", async () => {
    const config = parseDaemonConfig({
      hostId: "a1",
      commandProfiles: {
        "echo-prompt": { argv: ["echo"], appendPrompt: true },
      },
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => {
        throw new Error("bad ref");
      },
      revParse: async () => "x",
    };
    const worktrees = new WorktreeManager(config, git);
    const sessionRunner = new SessionRunner({
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const result = await sessionRunner.run(baseAssign({ ref: "missing" }));
    expect(result.errorCode).toBe("setup_failed");
    expect(result.errorMessage).toContain("bad ref");

    const worktrees2 = new WorktreeManager(config, {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => {
        throw "co-nope";
      },
      revParse: async () => "x",
    });
    const runner2 = new SessionRunner({
      worktrees: worktrees2,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect((await runner2.run(baseAssign())).errorMessage).toBe("co-nope");
  });
});
