import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

describe("SessionRunner setup environment", () => {
  it("layers host setup before the effective worktree setup and forwards exports", async () => {
    const config = parseDaemonConfig({
      hostId: "a1",
      setupScript: "host-setup",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          setupScript: "repository-setup",
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/repo/wt-1",
              labels: [],
              setupScript: "worktree-setup",
            },
          ],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      prepareMainCheckout: async () => undefined,
      revParse: async () => "x",
    };
    const setupOrder: string[] = [];
    let commandEnvironment: NodeJS.ProcessEnv | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        const shellScript = options.argv[1] === "-c" ? options.argv[2] : undefined;
        if (shellScript?.includes("host-setup")) {
          setupOrder.push("host");
          return {
            exitCode: 0,
            timedOut: false,
            signal: null,
            environment: { ...options.env, HOST_SETUP: "loaded" },
          };
        }
        if (shellScript?.includes("worktree-setup")) {
          setupOrder.push("worktree");
          expect(options.env?.HOST_SETUP).toBe("loaded");
          return {
            exitCode: 0,
            timedOut: false,
            signal: null,
            environment: { ...options.env, REPOSITORY_SETUP: "loaded" },
          };
        }
        commandEnvironment = options.env;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({
      worktrees: new WorktreeManager(config, git),
      processRunner: runner,
    }).run(baseAssign());
    expect(result.status).toBe("completed");
    expect(setupOrder).toEqual(["host", "worktree"]);
    expect(commandEnvironment).toMatchObject({
      HOST_SETUP: "loaded",
      REPOSITORY_SETUP: "loaded",
    });
  });
});
