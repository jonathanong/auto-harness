import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
  pty: undefined as FakeRawPty | undefined,
  ptyOptions: undefined as { envs?: Record<string, string> } | undefined,
}));

vi.mock("@replit/ruspty", () => ({
  // A plain function, not a class: `new Pty(...)` uses this returned object
  // instead of `this` per ordinary JS constructor semantics, and a
  // single-constructor class here would just be a no-extraneous-class lint hit.
  Pty: function (options: {
    envs?: Record<string, string>;
    onExit: (error: Error | null, code: number) => void;
  }) {
    spawned.ptyOptions = options;
    spawned.pty!.onExit = options.onExit;
    return spawned.pty;
  },
}));

import { PtyProcessRunner } from "./pty-runner.ts";

class FakeRawPty {
  pid = 4242;
  read = new EventEmitter();
  write = new EventEmitter();
  onExit: ((error: Error | null, code: number) => void) | undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spawnRuspty adapter", () => {
  it("resolves an unhandled pty.read error as an abnormal exit instead of crashing the daemon", async () => {
    // The ruspty wrapper's own handleError re-throws any errno beyond
    // EINTR/EAGAIN/EIO on its upstream socket -- unreachable from here, since
    // that throw aborts its emit() before any listener registered afterward
    // (including on the aliased `write` stream) runs. This test instead
    // covers the one crash class spawnRuspty *can* actually prevent: an
    // error from the downstream SyntheticEOFDetector pipe stage itself,
    // which `.pipe()` never auto-forwards to a listener on the upstream.
    const fakePty = new FakeRawPty();
    spawned.pty = fakePty;
    const run = new PtyProcessRunner().run({
      argv: ["node", "-e", "1"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onChunk: () => undefined,
    });
    // Wait for spawnRuspty's own dynamic `import("@replit/ruspty")` to
    // actually resolve and attach its listener before driving the fake --
    // a fixed setTimeout(…, 0) is not reliable here: under a loaded test
    // run (the full suite, not this file alone) that import can take longer
    // than one macrotask tick, and emitting before the listener attaches is
    // itself an unhandled 'error' that fails this test for the wrong reason.
    await vi.waitFor(() => {
      if (fakePty.read.listenerCount("error") === 0) throw new Error("not attached yet");
    });
    fakePty.read.emit("error", new Error("simulated SyntheticEOFDetector failure"));
    await expect(run).resolves.toEqual({ exitCode: 1, signal: null, timedOut: false });
  });

  it("kills the still-running child on a pty.read error, since that path doesn't imply the process exited", async () => {
    const fakePty = new FakeRawPty();
    spawned.pty = fakePty;
    const kill = vi.fn();
    const run = new PtyProcessRunner({ kill }).run({
      argv: ["node", "-e", "1"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onChunk: () => undefined,
    });
    await vi.waitFor(() => {
      if (fakePty.read.listenerCount("error") === 0) throw new Error("not attached yet");
    });
    fakePty.read.emit("error", new Error("simulated SyntheticEOFDetector failure"));
    await run;
    expect(kill).toHaveBeenCalledWith(-fakePty.pid, "SIGKILL");
  });

  it("injects TERM from the documented terminal type when the child env has none", async () => {
    const fakePty = new FakeRawPty();
    spawned.pty = fakePty;
    spawned.ptyOptions = undefined;
    // A real PATH (so "node" resolves), with TERM deliberately absent -- the
    // scenario for a systemd/launchd-launched daemon with no controlling tty.
    const { TERM: _term, ...envWithoutTerm } = process.env;
    const run = new PtyProcessRunner().run({
      argv: ["node", "-e", "1"],
      cwd: process.cwd(),
      env: envWithoutTerm,
      timeoutMs: 5_000,
      onChunk: () => undefined,
    });
    await vi.waitFor(() => {
      if (!spawned.ptyOptions) throw new Error("not spawned yet");
    });
    expect(spawned.ptyOptions.envs?.TERM).toBe("xterm-256color");
    fakePty.onExit?.(null, 0);
    await run;
  });

  it("keeps an explicitly configured TERM instead of overriding it", async () => {
    const fakePty = new FakeRawPty();
    spawned.pty = fakePty;
    spawned.ptyOptions = undefined;
    const run = new PtyProcessRunner().run({
      argv: ["node", "-e", "1"],
      cwd: process.cwd(),
      env: { ...process.env, TERM: "screen" },
      timeoutMs: 5_000,
      onChunk: () => undefined,
    });
    await vi.waitFor(() => {
      if (!spawned.ptyOptions) throw new Error("not spawned yet");
    });
    expect(spawned.ptyOptions.envs?.TERM).toBe("screen");
    fakePty.onExit?.(null, 0);
    await run;
  });
});
