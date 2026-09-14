import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SpawnProcessRunner, type ProcessRunner } from "./executor.ts";
import { hardTimeoutKillBudget } from "./hard-timeout-kill-budget.ts";
import { runTerminalHook } from "./terminal-hook.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeHook(body: string): Promise<{ root: string; hook: string }> {
  const root = join(tmpdir(), `ah-hook-deadline-${String(Date.now())}-${Math.random()}`);
  fixtures.push(root);
  await mkdir(root);
  const hook = join(root, "hook.sh");
  await writeFile(hook, body, { mode: 0o755 });
  return { root, hook };
}

describe("terminal hook hard kill deadline", () => {
  it("maps the hook timeout onto a hard kill deadline, including SIGKILL", async () => {
    const seen: Array<{ timeoutMs: number; terminationGraceMs?: number }> = [];
    const runner: ProcessRunner = {
      async run(opts) {
        seen.push({
          timeoutMs: opts.timeoutMs,
          ...(opts.terminationGraceMs !== undefined
            ? { terminationGraceMs: opts.terminationGraceMs }
            : {}),
        });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await runTerminalHook(runner, {
      scriptPath: "/h.sh",
      cwd: "/wt",
      sessionId: "s",
      status: "completed",
      worktreePath: "/wt",
    });
    await runTerminalHook(runner, {
      scriptPath: "/h.sh",
      cwd: "/wt",
      sessionId: "s",
      status: "failed",
      worktreePath: "/wt",
      timeoutMs: 10_000,
    });
    await runTerminalHook(runner, {
      scriptPath: "/h.sh",
      cwd: "/wt",
      sessionId: "s",
      status: "failed",
      worktreePath: "/wt",
      timeoutMs: 3_000,
    });
    expect(seen).toEqual([
      hardTimeoutKillBudget(60_000),
      hardTimeoutKillBudget(10_000),
      hardTimeoutKillBudget(3_000),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "SIGKILLs a SIGTERM-ignoring hook by the hard timeout, not timeout plus 5s",
    async () => {
      const { root, hook } = await writeHook("#!/bin/sh\ntrap '' TERM\nsleep 30\n");
      const start = Date.now();
      await runTerminalHook(new SpawnProcessRunner(), {
        scriptPath: hook,
        cwd: root,
        sessionId: "s",
        status: "failed",
        worktreePath: root,
        timeoutMs: 400,
      });
      expect(Date.now() - start).toBeLessThan(2_000);
    },
  );

  it.skipIf(process.platform === "win32")(
    "lets a cooperative hook exit on SIGTERM without waiting out the default grace",
    async () => {
      const { root, hook } = await writeHook("#!/bin/sh\nsleep 30\n");
      const start = Date.now();
      await runTerminalHook(new SpawnProcessRunner(), {
        scriptPath: hook,
        cwd: root,
        sessionId: "s",
        status: "failed",
        worktreePath: root,
        timeoutMs: 400,
      });
      expect(Date.now() - start).toBeLessThan(2_000);
    },
  );

  it.skipIf(process.platform === "win32")(
    "SIGKILLs a SIGTERM-ignoring process at timeout when grace is 0",
    async () => {
      const start = Date.now();
      const result = await new SpawnProcessRunner().run({
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
        ],
        cwd: process.cwd(),
        timeoutMs: 400,
        terminationGraceMs: 0,
        onChunk: () => undefined,
      });
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
    },
  );

  it.skipIf(process.platform === "win32")(
    "lets a cooperative process exit on SIGTERM without waiting for SIGKILL",
    async () => {
      const start = Date.now();
      const result = await new SpawnProcessRunner().run({
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)",
        ],
        cwd: process.cwd(),
        timeoutMs: 400,
        terminationGraceMs: 5_000,
        onChunk: () => undefined,
      });
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(result.timedOut).toBe(true);
      expect(result.signal).not.toBe("SIGKILL");
    },
  );
});
