import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ child: undefined as FakeChild | undefined }));

vi.mock("node:child_process", () => ({
  spawn: () => spawned.child,
}));

import { SpawnProcessRunner } from "./executor.ts";

class FakeChild extends EventEmitter {
  pid = 12_345;
  stdout = undefined;
  stderr = undefined;
  closeOnKill = true;
  throwOnKill = true;

  kill(): boolean {
    if (this.closeOnKill) queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    if (this.throwOnKill) throw new Error("already reaped");
    return true;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SpawnProcessRunner signal fallback", () => {
  it("tolerates both process-group and direct-child signal failures", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no process group");
    });
    spawned.child = new FakeChild();
    await expect(
      new SpawnProcessRunner().run({
        argv: ["fake-command"],
        cwd: "/tmp",
        timeoutMs: 1,
        terminationGraceMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ timedOut: true, exitCode: null, signal: "SIGTERM" });
  });

  it("ignores a second stop request while cancellation is in progress", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
    const child = new FakeChild();
    child.closeOnKill = false;
    child.throwOnKill = false;
    spawned.child = child;
    const controller = new AbortController();
    const run = new SpawnProcessRunner().run({
      argv: ["fake-command"],
      cwd: "/tmp",
      timeoutMs: 10,
      terminationGraceMs: 1_000,
      signal: controller.signal,
      onChunk: () => undefined,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    child.emit("close", null, "SIGTERM");
    await expect(run).resolves.toMatchObject({ cancelled: true, timedOut: false });
  });

  it("SIGKILLs immediately after SIGTERM when termination grace is 0", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(signal as NodeJS.Signals);
      return true;
    });
    const child = new FakeChild();
    child.closeOnKill = false;
    child.throwOnKill = false;
    spawned.child = child;
    const run = new SpawnProcessRunner({ platform: "linux" }).run({
      argv: ["fake-command"],
      cwd: "/tmp",
      timeoutMs: 3_000,
      terminationGraceMs: 0,
      onChunk: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("close", null, "SIGKILL");
    await expect(run).resolves.toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("does not schedule a second Windows taskkill when termination grace is 0", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.closeOnKill = false;
    child.throwOnKill = false;
    spawned.child = child;
    const calls: number[] = [];
    const run = new SpawnProcessRunner({
      platform: "win32",
      killWindowsProcessTree: (pid) => {
        calls.push(pid);
        return true;
      },
    }).run({
      argv: ["fake-command"],
      cwd: "/tmp",
      timeoutMs: 3_000,
      terminationGraceMs: 0,
      onChunk: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toEqual([12_345]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual([12_345]);
    child.emit("close", 1, null);
    await expect(run).resolves.toMatchObject({ timedOut: true });
  });

  it("clears pending escalation and an abort listener on child error", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
    const child = new FakeChild();
    child.closeOnKill = false;
    child.throwOnKill = false;
    spawned.child = child;
    const run = new SpawnProcessRunner().run({
      argv: ["fake-command"],
      cwd: "/tmp",
      timeoutMs: 1,
      terminationGraceMs: 1_000,
      signal: new AbortController().signal,
      onChunk: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(1);
    child.emit("error", new Error("child failed"));
    await expect(run).rejects.toThrow("child failed");
  });
});
