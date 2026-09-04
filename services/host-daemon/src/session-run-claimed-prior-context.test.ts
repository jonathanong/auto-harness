import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";

const identity = { apiUrl: "http://127.0.0.1:7420", apiKey: "secret" };
const okRunner: ProcessRunner = {
  async run() {
    return { exitCode: 0, timedOut: false, signal: null };
  },
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "session-run-claimed-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function claimedAt(dir: string) {
  return {
    repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
    worktree: { id: "wt-1", name: "wt", path: dir, labels: [] },
    cwd: dir,
  };
}

describe("prior-session context on a fallback resume assignment", () => {
  it("writes the file after setup and before spawn, then removes it after exit", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("fetched");
        return new Response(JSON.stringify({ content: "prior transcript" }), { status: 200 });
      }),
    );
    let sawFileDuringSpawn: string | null = null;
    const commandRunner: ProcessRunner = {
      async run() {
        order.push("spawned");
        sawFileDuringSpawn = await readFile(
          join(cwd, ".auto-harness", "prior-session.md"),
          "utf8",
        ).catch(() => null);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: unknown[] = [];
    const outcome = await runClaimedSession(
      okRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ priorContext: { sourceSessionId: "sess-1" } }),
      claimedAt(cwd),
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      identity,
    );

    expect(outcome).toMatchObject({ status: "completed" });
    expect(order).toEqual(["fetched", "spawned"]);
    expect(sawFileDuringSpawn).toBe("prior transcript");
    await expect(stat(join(cwd, ".auto-harness", "prior-session.md"))).rejects.toThrow();
  });

  it("does not fetch or write anything when the assign carries no priorContext", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const logs: unknown[] = [];
    const outcome = await runClaimedSession(
      okRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({}),
      claimedAt(cwd),
      undefined,
      () => false,
      () => 1_000,
      okRunner,
      process.env,
      undefined,
      identity,
    );
    expect(outcome).toMatchObject({ status: "completed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fetch when no daemon identity is available", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const logs: unknown[] = [];
    const outcome = await runClaimedSession(
      okRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ priorContext: { sourceSessionId: "sess-1" } }),
      claimedAt(cwd),
      undefined,
      () => false,
      () => 1_000,
      okRunner,
    );
    expect(outcome).toMatchObject({ status: "completed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("injects HARNESS_PRIOR_CONTEXT_FILE into the spawned process env", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: "x" }), { status: 200 })),
    );
    let sawEnv: NodeJS.ProcessEnv = {};
    const commandRunner: ProcessRunner = {
      async run(options) {
        sawEnv = options.env ?? {};
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: unknown[] = [];
    await runClaimedSession(
      okRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ priorContext: { sourceSessionId: "sess-1" } }),
      claimedAt(cwd),
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      identity,
    );
    expect(sawEnv.HARNESS_PRIOR_CONTEXT_FILE).toBe(join(cwd, ".auto-harness", "prior-session.md"));
  });

  it("still runs to completion when the prior-context fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const logs: unknown[] = [];
    const outcome = await runClaimedSession(
      okRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ priorContext: { sourceSessionId: "sess-1" } }),
      claimedAt(cwd),
      undefined,
      () => false,
      () => 1_000,
      okRunner,
      process.env,
      undefined,
      identity,
    );
    expect(outcome).toMatchObject({ status: "completed" });
  });
});
