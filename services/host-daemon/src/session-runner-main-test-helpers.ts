import type { ProcessRunner } from "./executor.ts";
import { SessionRunner } from "./session-runner.ts";
import type { DaemonConfig } from "./config.ts";
import type { GitClient } from "./git.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function makeRunner() {
  const config: DaemonConfig = {
    hostId: "h",
    logLevel: "info",
    repositories: [
      {
        id: "r1",
        path: "/repo-1",
        defaultBranch: "main",
        worktrees: [],
        terminalHookScript: "/hook",
      },
      { id: "r2", path: "/repo-2", defaultBranch: "trunk", worktrees: [] },
    ],
    providerAccounts: [],
    commandProfiles: {},
  };
  const checkouts: string[] = [];
  const hooks: string[] = [];
  const starts: string[] = [];
  const throwPrimary = { value: false };
  const throwCheckout = { value: false };
  const throwSetup = { value: false };
  const waits = new Map<string, ReturnType<typeof deferred<void>>>();
  const git: GitClient = {
    ensureRepo: async () => undefined,
    ensureWorktree: async () => undefined,
    checkoutRef: async () => undefined,
    prepareMainCheckout: async ({ cwd, ref }) => {
      if (throwCheckout.value) {
        throwCheckout.value = false;
        throw new Error("checkout failed");
      }
      checkouts.push(`${cwd}:${ref}`);
    },
    revParse: async () => "sha",
  };
  const processRunner: ProcessRunner = {
    async run(options) {
      if (options.argv[0] === "/bin/sh") {
        if (options.argv[1] === "-c" && throwSetup.value) {
          throwSetup.value = false;
          throw new Error("setup failed");
        }
        if (options.argv[1] === "/hook") hooks.push(options.cwd);
        return { exitCode: 0, timedOut: false, signal: null };
      }
      starts.push(options.cwd);
      if (throwPrimary.value) {
        throwPrimary.value = false;
        throw new Error("primary failed");
      }
      const wait = waits.get(options.cwd);
      if (wait) await wait.promise;
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
  const worktrees = new WorktreeManager(config, git);
  return {
    config,
    checkouts,
    hooks,
    starts,
    waits,
    throwPrimary,
    throwCheckout,
    throwSetup,
    runner: new SessionRunner({ worktrees, processRunner }),
  };
}

export async function viTick(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}
