import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
  child: undefined as FakeChild | undefined,
  calls: [] as unknown[][],
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawned.calls.push(args);
    return spawned.child;
  },
}));

import { SpawnProcessRunner } from "./executor.ts";

class FakeChild extends EventEmitter {
  pid: number | undefined = 12_345;
  stdout = undefined;
  stderr = undefined;

  kill(): boolean {
    return true;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  spawned.calls = [];
});

describe("SpawnProcessRunner Windows process-tree kill", () => {
  it("reaches the descendant tree via taskkill instead of signalling the direct child alone", async () => {
    const child = new FakeChild();
    spawned.child = child;
    const kill = vi.spyOn(child, "kill");
    const calls: number[] = [];
    const runner = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: (pid) => {
        calls.push(pid);
        queueMicrotask(() => child.emit("close", null, null));
        return true;
      },
    });
    const result = await runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 1,
      terminationGraceMs: 1_000,
      onChunk: () => undefined,
    });
    expect(calls).toEqual([12_345]);
    expect(kill).not.toHaveBeenCalled();
    expect(result).toMatchObject({ timedOut: true });
  });

  it("falls back to child.kill() when the taskkill dependency reports failure", async () => {
    const child = new FakeChild();
    spawned.child = child;
    const kill = vi.spyOn(child, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    const calls: number[] = [];
    const runner = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: (pid) => {
        calls.push(pid);
        return false;
      },
    });
    const result = await runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 1,
      terminationGraceMs: 1_000,
      onChunk: () => undefined,
    });
    expect(calls).toEqual([12_345]);
    expect(kill).toHaveBeenCalled();
    expect(result).toMatchObject({ timedOut: true });
  });

  it("falls back to child.kill() when the taskkill dependency throws", async () => {
    const child = new FakeChild();
    spawned.child = child;
    const kill = vi.spyOn(child, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    const runner = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: () => {
        throw new Error("taskkill unavailable");
      },
    });
    const result = await runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 1,
      terminationGraceMs: 1_000,
      onChunk: () => undefined,
    });
    expect(kill).toHaveBeenCalled();
    expect(result).toMatchObject({ timedOut: true });
  });

  it("falls back to child.kill() when the child pid is unknown", async () => {
    const child = new FakeChild();
    child.pid = undefined;
    spawned.child = child;
    const kill = vi.spyOn(child, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    const treeKillCalls: number[] = [];
    const runner = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: (pid) => {
        treeKillCalls.push(pid);
        return true;
      },
    });
    const result = await runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 1,
      terminationGraceMs: 1_000,
      onChunk: () => undefined,
    });
    expect(treeKillCalls).toEqual([]);
    expect(kill).toHaveBeenCalled();
    expect(result).toMatchObject({ timedOut: true });
  });

  it("does not detach a win32 child into its own process group", async () => {
    const child = new FakeChild();
    spawned.child = child;
    const runner = new SpawnProcessRunner({ platform: "win32" });
    const run = runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      onChunk: () => undefined,
    });
    queueMicrotask(() => child.emit("close", 0, null));
    await run;
    expect(spawned.calls).toEqual([
      ["fake-command", [], expect.objectContaining({ detached: false })],
    ]);
  });

  it("does not retry the tree-kill after the grace period, since a delayed pid re-kill risks hitting a recycled Windows pid", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawned.child = child;
    const calls: number[] = [];
    const runner = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: (pid) => {
        calls.push(pid);
        return true;
      },
    });
    const run = runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 1,
      terminationGraceMs: 50,
      onChunk: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([12_345]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([12_345]);
    child.emit("close", 1, null);
    // exitCode/signal here just mirror the close event this test emits, not
    // an observed Windows exit contract; the assertion that matters is
    // `calls` staying at length 1 above.
    await expect(run).resolves.toMatchObject({ timedOut: true });
  });

  it("does not taskkill a pid after the root process has already exited, since Windows may have recycled it", async () => {
    const child = new FakeChild();
    spawned.child = child;
    const kill = vi.spyOn(child, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, null));
      return true;
    });
    const treeKillCalls: number[] = [];
    const runner = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: (pid) => {
        treeKillCalls.push(pid);
        return true;
      },
    });
    const run = runner.run({
      argv: ["fake-command"],
      cwd: process.cwd(),
      timeoutMs: 1,
      terminationGraceMs: 1_000,
      onChunk: () => undefined,
    });
    // The direct child (a cmd.exe launcher) has exited, but a backgrounded
    // descendant still holds the inherited stdio open, so "close" has not
    // fired yet -- the exact window in which child.pid is stale.
    child.emit("exit", 0, null);
    await run;
    expect(treeKillCalls).toEqual([]);
    expect(kill).toHaveBeenCalled();
  });
});
