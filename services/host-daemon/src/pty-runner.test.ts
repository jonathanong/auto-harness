import type { IPty } from "node-pty";
import { describe, expect, it } from "vitest";

import { PtyProcessRunner, type PtySpawn } from "./pty-runner.ts";

type ExitEvent = { exitCode: number; signal?: number };

function fakePty() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: ExitEvent) => void) | undefined;
  const killed: Array<string | undefined> = [];
  const terminal = {
    pid: 321,
    kill(signal?: string) {
      killed.push(signal);
    },
    onData(listener: (data: string) => void) {
      onData = listener;
      return { dispose() {} };
    },
    onExit(listener: (event: ExitEvent) => void) {
      onExit = listener;
      return { dispose() {} };
    },
  } as IPty;
  return {
    emitData: (data: string) => onData?.(data),
    emitExit: (event: ExitEvent) => onExit?.(event),
    killed,
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
        queueMicrotask(() => {
          pty.emitData("ready\r\n");
          pty.emitExit({ exitCode: 0 });
        });
        return pty.terminal;
      },
    });
    const chunks: string[] = [];

    await expect(
      runner.run({
        argv: ["tool", "literal;not-a-shell", "$(still-literal)"],
        cwd: process.cwd(),
        env: { PATH: "/bin", TERM: "caller-value" },
        timeoutMs: 1_000,
        onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.data}`),
      }),
    ).resolves.toEqual({ exitCode: 0, signal: null, timedOut: false });
    expect(spawned).toEqual([
      "tool",
      ["literal;not-a-shell", "$(still-literal)"],
      {
        cols: 120,
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: "/bin", TERM: "caller-value" },
        name: "xterm-256color",
        rows: 40,
      },
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

  it("signals the process group and escalates an ignored timeout", async () => {
    const pty = fakePty();
    const signals: Array<[number, NodeJS.Signals]> = [];
    const runner = new PtyProcessRunner({
      kill(pid, signal) {
        signals.push([pid, signal as NodeJS.Signals]);
        if (signal === "SIGKILL") queueMicrotask(() => pty.emitExit({ exitCode: 0, signal: 9 }));
        return true;
      },
      platform: "linux",
      spawn: () => pty.terminal,
    });

    await expect(
      runner.run({
        argv: ["tool"],
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
        if (signal === "SIGTERM") queueMicrotask(() => pty.emitExit({ exitCode: 0, signal: 15 }));
        return true;
      },
      platform: "darwin",
      spawn: () => pty.terminal,
    });
    const run = runner.run({
      argv: ["tool"],
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

  it("falls back to node-pty kill and bounds merged output", async () => {
    const pty = fakePty();
    const controller = new AbortController();
    const runner = new PtyProcessRunner({
      kill() {
        throw new Error("group unavailable");
      },
      platform: "linux",
      spawn: () => pty.terminal,
    });
    const chunks: string[] = [];
    const run = runner.run({
      argv: ["tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    pty.emitData("x".repeat(40_000));
    controller.abort();
    expect(pty.killed).toEqual(["SIGTERM"]);
    pty.emitExit({ exitCode: 0, signal: 15 });
    await expect(run).resolves.toMatchObject({ cancelled: true });
    expect(chunks).toHaveLength(2);
    expect(Buffer.byteLength(chunks[0]!, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(chunks[1]).toContain("output chunk truncated");
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
        argv: ["missing-tool"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("executable not found in PATH");
  });
});
