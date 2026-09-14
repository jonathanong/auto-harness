import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function git(): GitClient {
  return {
    ensureRepo: async () => undefined,
    ensureWorktree: async () => undefined,
    checkoutRef: async () => SHA,
    prepareMainCheckout: async () => undefined,
    revParse: async () => SHA,
  };
}

async function cachedRunner(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const cacheDir = await mkdtemp(join(tmpdir(), `${prefix}cache-`));
  await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-1");
  const config = parseDaemonConfig({
    hostId: "a1",
    repositories: [
      {
        id: "repo-1",
        path: cwd,
        defaultBranch: "main",
        setupScript: "pnpm install",
        setupCacheInputs: ["pnpm-lock.yaml"],
        worktrees: [{ id: "wt-1", name: "wt-1", path: cwd, labels: [] }],
      },
    ],
  });
  const setupCalls = { n: 0 };
  const runner: ProcessRunner = {
    async run(options) {
      if (options.argv[1] === "-c") {
        setupCalls.n += 1;
        await mkdir(join(cwd, "node_modules"), { recursive: true });
        await writeFile(join(cwd, "node_modules/ok"), "from-setup");
        return { exitCode: 0, timedOut: false, signal: null, environment: options.env ?? {} };
      }
      await writeFile(join(cwd, "node_modules/ok"), "from-command");
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
  return {
    cwd,
    setupCalls,
    sessionRunner: new SessionRunner({
      worktrees: new WorktreeManager(config, git()),
      processRunner: runner,
      setupCacheDir: cacheDir,
    }),
  };
}

describe("SessionRunner setup cache after command", () => {
  it("does not skip setup on a later fresh session after ignored outputs mutate", async () => {
    const { cwd, setupCalls, sessionRunner } = await cachedRunner("auto-harness-setup-cache-cmd-");
    const first = await sessionRunner.run(baseAssign());
    expect(first.status).toBe("completed");
    expect(setupCalls.n).toBe(1);
    expect(first.logs.some((chunk) => chunk.content === "Running setup script...")).toBe(true);
    await writeFile(join(cwd, "node_modules/ok"), "leftover");
    const second = await sessionRunner.run(
      baseAssign({ sessionId: "sess-2", attemptId: "attempt-2" }),
    );
    expect(second.status).toBe("completed");
    expect(setupCalls.n).toBe(2);
    expect(second.logs.some((chunk) => chunk.content === "Running setup script...")).toBe(true);
    expect(second.logs.some((chunk) => chunk.content === "Setup unchanged; skipping.")).toBe(false);
  });

  it("still skips native resume after a command has invalidated the cache", async () => {
    const { setupCalls, sessionRunner } = await cachedRunner(
      "auto-harness-setup-cache-resume-cmd-",
    );
    await sessionRunner.run(baseAssign());
    expect(setupCalls.n).toBe(1);
    const resume = await sessionRunner.run(
      baseAssign({ sessionId: "sess-2", attemptId: "attempt-2", resume: true }),
    );
    expect(resume.status).toBe("completed");
    expect(setupCalls.n).toBe(1);
    expect(resume.logs.some((chunk) => chunk.content === "Running setup script...")).toBe(false);
    expect(resume.logs.some((chunk) => chunk.content === "Setup unchanged; skipping.")).toBe(false);
  });
});
