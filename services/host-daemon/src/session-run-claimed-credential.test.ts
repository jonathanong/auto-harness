import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

describe("session command credential", () => {
  let cwd: string | undefined;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("redacts a printed credential even when it is split across chunks", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-credential-"));
    const credential = "hns_session_ephemeral";
    const commandRunner: ProcessRunner = {
      async run(options) {
        options.onChunk?.({ stream: "stdout", data: "token=hns_session_" });
        options.onChunk?.({ stream: "stdout", data: "ephemeral\n" });
        options.onChunk?.({ stream: "stderr", data: `${credential}\n` });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ sessionApiKey: credential }),
      {
        repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
        worktree: { id: "wt-1", name: "wt", path: cwd, labels: [] },
        cwd,
      },
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      { apiUrl: "http://127.0.0.1:7420", apiKey: "host-secret" },
    );
    const transcript = logs.map((chunk) => chunk.content).join("");
    expect(transcript).not.toContain(credential);
    expect(transcript.match(/\[session credential redacted\]/g)).toHaveLength(2);
  });

  it("drains an output chunk that ends with only a credential prefix", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-credential-prefix-"));
    const credential = "hns_session_ephemeral";
    const commandRunner: ProcessRunner = {
      async run(options) {
        options.onChunk?.({ stream: "stdout", data: credential.slice(0, -1) });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-prefix", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ sessionApiKey: credential }),
      {
        repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
        worktree: { id: "wt-1", name: "wt", path: cwd, labels: [] },
        cwd,
      },
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      { apiUrl: "http://127.0.0.1:7420", apiKey: "host-secret" },
    );
    const transcript = logs.map((chunk) => chunk.content).join("");
    expect(transcript).toContain(credential.slice(0, -1));
    expect(transcript).not.toContain(credential);
  });

  it.each([
    ["completed", { exitCode: 0, timedOut: false }],
    ["failed", { exitCode: 1, timedOut: false }],
    ["timed_out", { exitCode: 1, timedOut: true }],
    ["cancelled", { exitCode: null, timedOut: false, cancelled: true }],
  ] as const)("retains an agent summary for a %s result", async (status, result) => {
    cwd = await mkdtemp(join(tmpdir(), `session-credential-${status}-`));
    let primary = true;
    const commandRunner: ProcessRunner = {
      async run() {
        if (primary) {
          primary = false;
          return { ...result, signal: null, agentSummary: "Child work was queued." };
        }
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    const outcome = await runClaimedSession(
      commandRunner,
      new LogStreamer(`sess-${status}`, "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ sessionApiKey: "hns_session_ephemeral" }),
      {
        repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
        worktree: { id: "wt-1", name: "wt", path: cwd, labels: [] },
        cwd,
      },
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      { apiUrl: "http://127.0.0.1:7420", apiKey: "host-secret" },
    );
    expect(outcome.status).toBe(status);
    expect(outcome.result).toEqual({
      summary: "Child work was queued.",
      summarySource: "agent",
    });
  });
});
