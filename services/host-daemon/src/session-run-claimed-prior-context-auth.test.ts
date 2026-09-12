import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const identity = { apiUrl: "http://127.0.0.1:7420", apiKey: "secret" };
const okRunner: ProcessRunner = {
  async run() {
    return { exitCode: 0, timedOut: false, signal: null };
  },
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "session-run-claimed-auth-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function claimedAt(dir: string) {
  return {
    repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
    worktree: { id: "wt-1", name: "wt", path: dir, labels: [] },
    cwd: dir,
  };
}

async function runWithAuthorization(
  authorize: Parameters<typeof runClaimedSession>[12],
  signal?: AbortSignal,
) {
  const logs: unknown[] = [];
  return await runClaimedSession(
    okRunner,
    new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
    logs as never,
    baseAssign({ priorContext: { sourceSessionId: "sess-1" } }),
    claimedAt(cwd),
    signal,
    () => false,
    () => 1_000,
    okRunner,
    process.env,
    undefined,
    identity,
    authorize,
  );
}

describe("prior-session context cleanup around command-start authorization", () => {
  it.each([
    ["denied", async () => false, "cancelled"],
    [
      "throws",
      async () => {
        throw new Error("authorization unavailable");
      },
      "failed",
    ],
  ] as const)(
    "removes prior context when authorization is %s",
    async (_name, authorize, status) => {
      const outcome = await runWithAuthorization(authorize);
      expect(outcome.status).toBe(status);
      await expect(stat(join(cwd, ".auto-harness", "prior-session.md"))).rejects.toThrow();
    },
  );

  it("removes prior context when authorization aborts the session", async () => {
    const controller = new AbortController();
    const outcome = await runWithAuthorization(async () => {
      controller.abort();
      return false;
    }, controller.signal);
    expect(outcome.status).toBe("cancelled");
    await expect(stat(join(cwd, ".auto-harness", "prior-session.md"))).rejects.toThrow();
  });
});
