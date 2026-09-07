import { describe, expect, it } from "vitest";

import { PtyProcessRunner, type PtyHandle } from "./pty-runner.ts";

describe("PtyProcessRunner defensive boundary", () => {
  it("reports a signal death the runner never requested as an unattributed exit code, not a guessed signal", async () => {
    // Documents the fidelity gap on PtyExitEvent: the pty backend can only
    // say "died by some signal" (signaled: true), never which one. The
    // runner attributes a signal death to the last signal *it* sent -- when
    // it never sent one (no timeout, no cancellation), there's nothing to
    // attribute it to, so `signal` is null and `exitCode` falls back to
    // ruspty's raw (meaningless, always -1) code rather than being nulled out.
    let exit: ((event: { exitCode: number; signaled: boolean }) => void) | undefined;
    const terminal: PtyHandle = {
      pid: 321,
      onData() {
        return { dispose() {} };
      },
      onExit(listener) {
        exit = listener;
        return { dispose() {} };
      },
    };
    const runner = new PtyProcessRunner({ spawn: () => terminal });
    const run = runner.run({
      argv: ["./tool"],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    exit?.({ exitCode: -1, signaled: true });
    await expect(run).resolves.toEqual({ exitCode: -1, signal: null, timedOut: false });
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
        argv: ["./tool"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toBe(failure);
  });
});
