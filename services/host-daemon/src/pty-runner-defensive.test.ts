import type { IPty } from "node-pty";
import { describe, expect, it } from "vitest";

import { PtyProcessRunner } from "./pty-runner.ts";

describe("PtyProcessRunner defensive boundary", () => {
  it("reports an unknown native signal as null", async () => {
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const terminal = {
      pid: 321,
      kill() {},
      onData() {
        return { dispose() {} };
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        exit = listener;
        return { dispose() {} };
      },
    } as IPty;
    const runner = new PtyProcessRunner({ spawn: () => terminal });
    const run = runner.run({
      argv: ["/opt/tool"],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });
    exit?.({ exitCode: 1, signal: 999 });
    await expect(run).resolves.toEqual({ exitCode: 1, signal: null, timedOut: false });
  });

  it("preserves unexpected spawn failures", async () => {
    const failure = new Error("native PTY initialization failed");
    const runner = new PtyProcessRunner({
      spawn() {
        throw failure;
      },
    });

    await expect(
      runner.run({
        argv: ["/opt/tool"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toBe(failure);
  });

  it("tolerates a direct-child signal racing with PTY exit on Windows", async () => {
    let emitExit: (() => void) | undefined;
    const terminal = {
      pid: 321,
      kill() {
        queueMicrotask(() => emitExit?.());
        throw new Error("already exited");
      },
      onData() {
        return { dispose() {} };
      },
      onExit(listener: (event: { exitCode: number }) => void) {
        emitExit = () => listener({ exitCode: 0 });
        return { dispose() {} };
      },
    } as IPty;
    const controller = new AbortController();
    const runner = new PtyProcessRunner({ platform: "win32", spawn: () => terminal });
    const run = runner.run({
      argv: ["/opt/tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 5,
      onChunk: () => undefined,
    });

    controller.abort();
    await expect(run).resolves.toEqual({
      cancelled: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
  });
});
