import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign, setup } from "./session-runner-test-helpers.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

function cancellableRunner(stage: "setup" | "main"): ProcessRunner {
  return {
    async run(options) {
      const isSetup = options.argv[0] === "/bin/sh" && options.argv[1] === "-c";
      const isHook = options.argv[0] === "/bin/sh" && options.argv[1] === "/hook.sh";
      if (isHook || (stage === "setup" ? !isSetup : isSetup)) {
        return { exitCode: 0, timedOut: false, signal: null };
      }
      return await new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => resolve({ exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" }),
          { once: true },
        );
      });
    },
  };
}

describe("SessionRunner cancellation", () => {
  it("cancels during setup", async () => {
    const { sessionRunner } = setup(cancellableRunner("setup"));
    const controller = new AbortController();
    const run = sessionRunner.run(baseAssign({ setupScript: "long-setup" }), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);
    await expect(run).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels during the primary command", async () => {
    const { sessionRunner } = setup(cancellableRunner("main"));
    const controller = new AbortController();
    const run = sessionRunner.run(baseAssign(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await expect(run).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels before checkout and releases the claim", async () => {
    const controller = new AbortController();
    controller.abort();
    let released = false;
    const runner = new SessionRunner({
      worktrees: fakeWorktrees(
        () => undefined,
        () => {
          released = true;
        },
      ),
      processRunner: cancellableRunner("main"),
    });
    await expect(runner.run(baseAssign(), { signal: controller.signal })).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(released).toBe(true);
  });

  it("preserves cancellation when an interrupted checkout rejects", async () => {
    const controller = new AbortController();
    const runner = new SessionRunner({
      worktrees: fakeWorktrees(
        () => undefined,
        () => undefined,
        async () => {
          controller.abort();
          throw new Error("git checkout interrupted");
        },
      ),
      processRunner: cancellableRunner("main"),
    });
    await expect(runner.run(baseAssign(), { signal: controller.signal })).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("reports a setup timeout without starting the primary command", async () => {
    const { sessionRunner } = setup({
      async run(options) {
        if (options.argv[0] === "/bin/sh" && options.argv[1] === "-c") {
          return { exitCode: null, timedOut: true, signal: "SIGTERM" };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    await expect(sessionRunner.run(baseAssign({ setupScript: "slow" }))).resolves.toMatchObject({
      status: "timed_out",
    });
  });

  it("times out the whole session when the combined deadline aborts the command", async () => {
    const { sessionRunner } = setup({
      async run(options) {
        return await new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" }),
            { once: true },
          );
        });
      },
    });
    await expect(sessionRunner.run(baseAssign({ timeout: 0.01 }))).resolves.toMatchObject({
      status: "timed_out",
    });
  });

  it("reports timeout when checkout returns after the session deadline", async () => {
    const runner = new SessionRunner({
      worktrees: fakeWorktrees(
        () => undefined,
        () => undefined,
        async () => await new Promise<void>((resolve) => setTimeout(resolve, 20)),
      ),
      processRunner: cancellableRunner("main"),
    });
    await expect(runner.run(baseAssign({ timeout: 0.01 }))).resolves.toMatchObject({
      status: "timed_out",
    });
  });
});

function fakeWorktrees(
  checkout: () => void,
  release: () => void,
  prepareCheckout: () => Promise<void> = async () => checkout(),
): WorktreeManager {
  return {
    claim: () => ({
      repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
      worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
      cwd: "/wt",
    }),
    prepareCheckout,
    release,
  } as unknown as WorktreeManager;
}
