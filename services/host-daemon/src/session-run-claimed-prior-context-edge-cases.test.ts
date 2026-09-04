import { mkdtemp, rm, stat } from "node:fs/promises";
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
  cwd = await mkdtemp(join(tmpdir(), "session-run-claimed-edge-"));
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

describe("prior-session context edge cases", () => {
  it("forwards allowedRoots and the cancellation signal to the context fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: "x" }), { status: 200 })),
    );
    const logs: unknown[] = [];
    const outcome = await runClaimedSession(
      okRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ priorContext: { sourceSessionId: "sess-1" } }),
      { ...claimedAt(cwd), allowedRoots: [cwd] },
      new AbortController().signal,
      () => false,
      () => 1_000,
      okRunner,
      process.env,
      undefined,
      identity,
    );
    expect(outcome).toMatchObject({ status: "completed" });
    await expect(stat(join(cwd, ".auto-harness", "prior-session.md"))).rejects.toThrow();
  });

  it("removes the context file even when the process run rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ content: "prior transcript" }), { status: 200 }),
      ),
    );
    const commandRunner: ProcessRunner = {
      run() {
        return Promise.reject(new Error("spawn exploded"));
      },
    };
    const logs: unknown[] = [];
    await expect(
      runClaimedSession(
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
      ),
    ).rejects.toThrow("spawn exploded");
    await expect(stat(join(cwd, ".auto-harness", "prior-session.md"))).rejects.toThrow();
  });
});
