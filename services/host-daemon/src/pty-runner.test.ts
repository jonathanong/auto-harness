/* eslint-disable max-lines, unicorn/consistent-function-scoping -- PTY resolution cases use local scenario helpers, matching git-commands.test.ts's precedent for the sibling call site. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PtyProcessRunner, type PtyHandle, type PtySpawn } from "./pty-runner.ts";

type ExitEvent = { exitCode: number; signaled?: boolean };

function fakePty() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: ExitEvent) => void) | undefined;
  const terminal: PtyHandle = {
    pid: 321,
    onData(listener: (data: string) => void) {
      onData = listener;
      return { dispose() {} };
    },
    onExit(listener: (event: { exitCode: number; signaled: boolean }) => void) {
      onExit = listener;
      return { dispose() {} };
    },
  };
  return {
    emitData: (data: string) => onData?.(data),
    emitExit: (event: ExitEvent) =>
      onExit?.({ exitCode: event.exitCode, signaled: event.signaled ?? false }),
    terminal,
  };
}

describe("PtyProcessRunner boundary", () => {
  it("passes argv without a shell and fixes the terminal contract at 120x40", async () => {
    const pty = fakePty();
    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      spawn: (...args) => {
        spawned = args;
        // A macrotask, not queueMicrotask: spawn() is now awaited (real
        // ruspty is async), so its own resumption already consumes a
        // microtask turn -- a microtask scheduled here, before that resumes,
        // would run first and find no listener attached yet.
        setTimeout(() => {
          pty.emitData("ready\r\n");
          pty.emitExit({ exitCode: 0 });
        }, 0);
        return pty.terminal;
      },
    });
    const chunks: string[] = [];

    await expect(
      runner.run({
        argv: ["./tool", "literal;not-a-shell", "$(still-literal)"],
        cwd: process.cwd(),
        env: { PATH: "/bin", TERM: "caller-value" },
        timeoutMs: 1_000,
        onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.data}`),
      }),
    ).resolves.toEqual({ exitCode: 0, signal: null, timedOut: false });
    expect(spawned).toEqual([
      join(process.cwd(), "tool"),
      ["literal;not-a-shell", "$(still-literal)"],
      {
        cols: 120,
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: "/bin", TERM: "caller-value" },
        name: "xterm-256color",
        rows: 40,
      },
      expect.any(Function),
    ]);
    expect(chunks).toEqual(["stdout:ready\r\n"]);
  });

  it("does not spawn after cancellation and explains invalid inputs", async () => {
    let calls = 0;
    const runner = new PtyProcessRunner({
      spawn: () => {
        calls += 1;
        return fakePty().terminal;
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run({
        argv: ["tool"],
        cwd: process.cwd(),
        signal: controller.signal,
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ cancelled: true, exitCode: null });
    await expect(
      runner.run({ argv: [], cwd: process.cwd(), timeoutMs: 1_000, onChunk: () => undefined }),
    ).rejects.toThrow("argv must be non-empty");
    await expect(
      runner.run({
        argv: ["tool"],
        cwd: "/tmp/auto-harness-pty-missing-cwd",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("working directory does not exist");
    expect(calls).toBe(0);
  });

  it("throws immediately on Windows, before resolving or spawning anything", async () => {
    let calls = 0;
    const runner = new PtyProcessRunner({
      platform: "win32",
      spawn: () => {
        calls += 1;
        return fakePty().terminal;
      },
    });
    await expect(
      runner.run({
        argv: ["tool"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("PTY sessions are not supported on Windows");
    expect(calls).toBe(0);
  });

  it("signals the process group and escalates an ignored timeout", async () => {
    const pty = fakePty();
    const signals: Array<[number, NodeJS.Signals]> = [];
    const runner = new PtyProcessRunner({
      kill(pid, signal) {
        signals.push([pid, signal as NodeJS.Signals]);
        if (signal === "SIGKILL")
          queueMicrotask(() => pty.emitExit({ exitCode: 0, signaled: true }));
        return true;
      },
      platform: "linux",
      spawn: () => pty.terminal,
    });

    await expect(
      runner.run({
        argv: ["./tool"],
        cwd: process.cwd(),
        timeoutMs: 5,
        terminationGraceMs: 5,
        onChunk: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: null, signal: "SIGKILL", timedOut: true });
    expect(signals).toEqual([
      [-321, "SIGTERM"],
      [-321, "SIGKILL"],
    ]);
  });

  it("still escalates descendants after the PTY leader exits on cancellation", async () => {
    const pty = fakePty();
    const signals: NodeJS.Signals[] = [];
    const controller = new AbortController();
    const runner = new PtyProcessRunner({
      kill(_pid, signal) {
        signals.push(signal as NodeJS.Signals);
        if (signal === "SIGTERM")
          queueMicrotask(() => pty.emitExit({ exitCode: 0, signaled: true }));
        return true;
      },
      platform: "darwin",
      spawn: () => pty.terminal,
    });
    const run = runner.run({
      argv: ["./tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 5,
      onChunk: () => undefined,
    });
    controller.abort();
    await expect(run).resolves.toMatchObject({ cancelled: true, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("re-arms the SIGKILL timer when it elapses as a no-op before a slow spawn resolves", async () => {
    // spawn() is async (real ruspty is) -- stop() can run before it resolves,
    // finding no terminal to signal yet. If its SIGKILL grace timer also
    // elapses before spawn resolves, that timer fires as a no-op too, and
    // must be re-armed once a terminal actually exists, or the child is
    // never killed at all.
    const pty = fakePty();
    const signals: NodeJS.Signals[] = [];
    const controller = new AbortController();
    const runner = new PtyProcessRunner({
      kill(_pid, signal) {
        signals.push(signal as NodeJS.Signals);
        if (signal === "SIGTERM")
          setTimeout(() => pty.emitExit({ exitCode: 0, signaled: true }), 0);
        return true;
      },
      platform: "linux",
      spawn: () => new Promise((resolve) => setTimeout(() => resolve(pty.terminal), 50)),
    });
    const run = runner.run({
      argv: ["./tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 5,
      onChunk: () => undefined,
    });
    controller.abort();
    await expect(run).resolves.toMatchObject({ cancelled: true, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("falls back to a direct-pid signal when the process group is unavailable, and bounds merged output", async () => {
    const pty = fakePty();
    const controller = new AbortController();
    const killed: Array<[number, NodeJS.Signals]> = [];
    const runner = new PtyProcessRunner({
      kill(pid, signal) {
        killed.push([pid, signal as NodeJS.Signals]);
        throw new Error("group unavailable");
      },
      platform: "linux",
      spawn: () => pty.terminal,
    });
    const chunks: string[] = [];
    const run = runner.run({
      argv: ["./tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    // Let run()'s await this.spawn(...) resolve and attach its listeners
    // before driving the fake pty -- spawn is async now (real ruspty is),
    // so nothing is attached yet in this same synchronous turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    pty.emitData("x".repeat(40_000));
    controller.abort();
    expect(killed).toEqual([
      [-321, "SIGTERM"],
      [321, "SIGTERM"],
    ]);
    pty.emitExit({ exitCode: 0, signaled: true });
    await expect(run).resolves.toMatchObject({ cancelled: true });
    expect(chunks).toHaveLength(2);
    expect(Buffer.byteLength(chunks[0]!, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(chunks[1]).toContain("output chunk truncated");
  });

  it("emits a read whole, unmarked, when emitUntruncated opts out of the runner's own cap", async () => {
    const pty = fakePty();
    const runner = new PtyProcessRunner({
      emitUntruncated: true,
      platform: "linux",
      spawn: () => pty.terminal,
    });
    const chunks: string[] = [];
    const run = runner.run({
      argv: ["./tool"],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    // Let run()'s await this.spawn(...) resolve and attach its listeners
    // before driving the fake pty -- spawn is async now (real ruspty is).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oversized = "x".repeat(40_000);
    pty.emitData(oversized);
    pty.emitExit({ exitCode: 0 });
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    expect(chunks).toEqual([oversized]);
  });

  it("normalizes missing-command errors from the native boundary", async () => {
    const runner = new PtyProcessRunner({
      spawn() {
        const error = new Error("File not found");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      },
    });
    await expect(
      runner.run({
        // A relative command is resolved lexically before this test exercises
        // native this.spawn() ENOENT normalization.
        argv: ["./missing-tool"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("executable not found in PATH");
  });
});

describe("PtyProcessRunner executable resolution", () => {
  function stubBinary(dir: string, filename: string): void {
    // Mode 0o755: resolution requires POSIX candidates to actually be
    // executable, not merely present.
    writeFileSync(join(dir, filename), "", { mode: 0o755 });
  }

  it("resolves a bare command from env.PATH before spawning", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-pty-resolve-"));
    stubBinary(binDir, "claude");
    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      platform: "linux",
      spawn: (...args) => {
        spawned = args;
        const pty = fakePty();
        // Macrotask: see the comment on the first spawn fake in this file.
        setTimeout(() => pty.emitExit({ exitCode: 0 }), 0);
        return pty.terminal;
      },
    });

    await runner.run({
      argv: ["claude", "--resume"],
      cwd: process.cwd(),
      env: { PATH: binDir },
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(spawned?.[0]).toBe(join(binDir, "claude"));
  });

  it("keeps a resolved command's argv on the direct spawn path regardless of extension", async () => {
    const scenarios: Array<{ command: string; platform: NodeJS.Platform }> = [
      { command: "./tool.cmd", platform: "linux" },
      { command: "./tool.bat", platform: "darwin" },
      { command: "./tool.sh", platform: "linux" },
    ];

    for (const scenario of scenarios) {
      let spawned: Parameters<PtySpawn> | undefined;
      const runner = new PtyProcessRunner({
        platform: scenario.platform,
        spawn: (...spawnArgs) => {
          spawned = spawnArgs;
          const pty = fakePty();
          // Macrotask: see the comment on the first spawn fake in this file.
          setTimeout(() => pty.emitExit({ exitCode: 0 }), 0);
          return pty.terminal;
        },
      });

      await runner.run({
        argv: [scenario.command, "literal&argument"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      });

      expect(spawned?.slice(0, 2)).toEqual([
        join(process.cwd(), scenario.command.slice(2)),
        ["literal&argument"],
      ]);
    }
  });

  it.each(["/opt/tool", "C:\\Tools\\tool.exe", "../tool"])(
    "rejects unsafe direct assignment before spawning: %s",
    async (command) => {
      let spawnCalls = 0;
      const runner = new PtyProcessRunner({
        platform: "linux",
        spawn: () => {
          spawnCalls += 1;
          return fakePty().terminal;
        },
      });

      await expect(
        runner.run({
          argv: [command],
          cwd: process.cwd(),
          timeoutMs: 1_000,
          onChunk: () => undefined,
        }),
      ).rejects.toThrow(/absolute or drive-qualified path|'\.\.' path segments/);
      expect(spawnCalls).toBe(0);
    },
  );

  it("throws before spawning when the command is not found anywhere on PATH", async () => {
    let spawnCalls = 0;
    const runner = new PtyProcessRunner({
      platform: "linux",
      spawn: () => {
        spawnCalls += 1;
        return fakePty().terminal;
      },
    });

    await expect(
      runner.run({
        argv: ["missing-tool"],
        cwd: process.cwd(),
        env: { PATH: mkdtempSync(join(tmpdir(), "auto-harness-pty-empty-path-")) },
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow('Cannot resolve trusted executable "missing-tool": not found on PATH');
    expect(spawnCalls).toBe(0);
  });
});
