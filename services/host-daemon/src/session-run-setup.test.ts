import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";

function pnpmWorkspaceDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "auto-harness-run-setup-direct-"));
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return cwd;
}

function claim(
  cwd: string,
  currentExecutionTarget?: () => Promise<void>,
  hostSetupScript?: string,
): ClaimedWorktree {
  return {
    repository: { id: "repo-1", path: cwd, defaultBranch: "main", worktrees: [] },
    worktree: { id: "wt-1", name: "wt-1", path: cwd, labels: [] },
    cwd,
    ...(currentExecutionTarget ? { currentExecutionTarget } : {}),
    ...(hostSetupScript !== undefined ? { hostSetupScript } : {}),
    currentHookTarget: async () => null,
  };
}

function noopStreamer(): { streamer: LogStreamer; logs: SessionLogChunk[] } {
  const logs: SessionLogChunk[] = [];
  const streamer = new LogStreamer(
    "sess-1",
    "attempt-1",
    (chunk) => logs.push(chunk),
    () => "2026-08-01T00:00:00.000Z",
  );
  return { streamer, logs };
}

async function run(
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  runner: ProcessRunner,
  signal?: AbortSignal,
) {
  const { streamer, logs } = noopStreamer();
  return runSetupIfNeeded(
    runner,
    streamer,
    logs,
    assign,
    claimed,
    signal,
    () => false,
    () => 30_000,
  );
}

describe("runSetupIfNeeded dependency install edge cases", () => {
  it("fails structurally when the install step's revalidation throws a non-Error value", async () => {
    const cwd = pnpmWorkspaceDir();
    const claimed = claim(cwd, () => {
      throw "boom";
    });
    const runner: ProcessRunner = {
      async run() {
        throw new Error("pnpm should not run when revalidation fails");
      },
    };
    const { failure } = await run(baseAssign(), claimed, runner);
    expect(failure).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "boom",
    });
  });

  it("fails structurally when revalidation throws before the first setup script runs", async () => {
    const cwd = pnpmWorkspaceDir();
    const claimed = claim(
      cwd,
      () => {
        throw new Error("inventory changed");
      },
      "custom-host-setup",
    );
    const runner: ProcessRunner = {
      async run() {
        throw new Error("setup script should not run when revalidation fails first");
      },
    };
    const { failure } = await run(baseAssign(), claimed, runner);
    expect(failure).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "inventory changed",
    });
  });

  it("marks the session cancelled when the signal is already aborted before the install-only step", async () => {
    const cwd = pnpmWorkspaceDir();
    const claimed = claim(cwd);
    const controller = new AbortController();
    controller.abort();
    const runner: ProcessRunner = {
      async run() {
        throw new Error("pnpm should not run once the signal is already aborted");
      },
    };
    const { failure } = await run(baseAssign(), claimed, runner, controller.signal);
    expect(failure).toMatchObject({ status: "cancelled" });
  });

  describe("install step timeout budget", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives the install step a fresh deadline instead of the setup script's leftover budget", async () => {
      vi.useFakeTimers();
      const cwd = pnpmWorkspaceDir();
      const claimed = claim(cwd, undefined, "custom-host-setup");
      let installTimeoutMs = -1;
      const runner: ProcessRunner = {
        async run(opts) {
          if (opts.argv[0] === "pnpm" || opts.argv[0] === "cmd.exe") {
            installTimeoutMs = opts.timeoutMs;
            return { exitCode: 0, timedOut: false, signal: null };
          }
          // Simulate a setup script that burns through most of the shared
          // 600s setup budget before the install step ever starts.
          vi.setSystemTime(Date.now() + 550_000);
          return { exitCode: 0, timedOut: false, signal: null, environment: {} };
        },
      };
      const { streamer, logs } = noopStreamer();
      await runSetupIfNeeded(
        runner,
        streamer,
        logs,
        baseAssign(),
        claimed,
        undefined,
        () => false,
        () => 700_000,
      );
      // The old shared deadline would have left only ~50s (600s cap minus
      // the 550s the setup script consumed). A fresh budget gets close to
      // the full 600s cap instead.
      expect(installTimeoutMs).toBeGreaterThan(590_000);
    });
  });
});
