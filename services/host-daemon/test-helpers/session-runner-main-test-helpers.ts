import type { ProcessResult, ProcessRunner, RunProcessOptions } from "../src/executor.ts";
import type { SessionLogChunk } from "@auto-harness/shared";
import { SessionRunner } from "../src/session-runner.ts";
import type { DaemonConfig } from "../src/config.ts";
import type { GitClient } from "../src/git.ts";
import { WorktreeManager } from "../src/worktree-manager.ts";
import type { SessionOutputSpool } from "../src/session-output-spool.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function makeRunner(
  deps: {
    sessionOutputSpool?: SessionOutputSpool;
    childEnvSource?: NodeJS.ProcessEnv;
    onCommand?: (options: RunProcessOptions) => void | Promise<void>;
    onHook?: (options: RunProcessOptions) => void | Promise<void>;
    commandResult?: ProcessResult;
    onLog?: (chunk: SessionLogChunk) => void;
    now?: () => string;
  } = {},
) {
  const config: DaemonConfig = {
    hostId: "h",
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
  };
  const checkouts: string[] = [];
  const hooks: string[] = [];
  const starts: string[] = [];
  const commandEnvs: NodeJS.ProcessEnv[] = [];
  const hookEnvs: NodeJS.ProcessEnv[] = [];
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
      const isSetup = options.argv[1] === "-c" && options.argv[3] === "auto-harness-setup";
      if (isSetup) {
        if (throwSetup.value) {
          throwSetup.value = false;
          throw new Error("setup failed");
        }
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          environment: options.env ?? {},
        };
      }
      if (options.argv[0] === "/bin/sh" && options.argv[1] === "/hook") {
        hooks.push(options.cwd);
        hookEnvs.push(options.env ?? {});
        await deps.onHook?.(options);
        return { exitCode: 0, timedOut: false, signal: null };
      }
      starts.push(options.cwd);
      commandEnvs.push(options.env ?? {});
      await deps.onCommand?.(options);
      if (throwPrimary.value) {
        throwPrimary.value = false;
        throw new Error("primary failed");
      }
      const wait = waits.get(options.cwd);
      if (wait) await wait.promise;
      return deps.commandResult ?? { exitCode: 0, timedOut: false, signal: null };
    },
  };
  const worktrees = new WorktreeManager(config, git);
  return {
    config,
    checkouts,
    hooks,
    starts,
    commandEnvs,
    hookEnvs,
    waits,
    throwPrimary,
    throwCheckout,
    throwSetup,
    runner: new SessionRunner({
      worktrees,
      processRunner,
      ...(deps.sessionOutputSpool ? { sessionOutputSpool: deps.sessionOutputSpool } : {}),
      ...(deps.onLog ? { onLog: deps.onLog } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.childEnvSource ? { childEnvSource: deps.childEnvSource } : {}),
    }),
  };
}

export async function viTick(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}
