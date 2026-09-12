/* eslint-disable max-lines -- credential boundary regressions share one runner fixture. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
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

  it("redacts a credential split across stdout and stderr", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-credential-streams-"));
    const credential = "hns_session_ephemeral";
    const commandRunner: ProcessRunner = {
      async run(options) {
        options.onChunk?.({ stream: "stdout", data: "hns_session_" });
        options.onChunk?.({ stream: "stderr", data: "ephemeral" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-streams", "attempt-1", (chunk) => logs.push(chunk)),
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
    expect(transcript).toContain("[session credential redacted]");
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
    expect(transcript).not.toContain(credential.slice(0, -1));
    expect(transcript).not.toContain(credential);
    expect(transcript).toContain("[session credential redacted]");

    const capturedLogs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-prefix-capture", "attempt-1", (chunk) => capturedLogs.push(chunk)),
      capturedLogs as never,
      baseAssign({
        sessionApiKey: credential,
        resumeRefCapture: { stream: "stdout", linePrefix: "resume: " },
      }),
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
    expect(capturedLogs.map((chunk) => chunk.content).join("")).toContain(
      "[session credential redacted]",
    );
  });

  it("redacts a credential prefix that continues across chunks and then diverges", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-credential-divergent-prefix-"));
    const credential = "hns_session_ephemeral";
    const commandRunner: ProcessRunner = {
      async run(options) {
        options.onChunk?.({ stream: "stdout", data: "hns_" });
        options.onChunk?.({ stream: "stdout", data: "session_" });
        options.onChunk?.({ stream: "stdout", data: "not-a-credential" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-divergent", "attempt-1", (chunk) => logs.push(chunk)),
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
    expect(transcript).not.toContain("hns_session_");
    expect(transcript).toContain("[session credential redacted]not-a-credential");
  });

  it("does not reconstruct a credential whose final character overlaps its prefix", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-credential-overlap-"));
    const credential = `hns_session_${"a".repeat(42)}h`;
    const commandRunner: ProcessRunner = {
      async run(options) {
        options.onChunk?.({ stream: "stdout", data: credential });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-overlap", "attempt-1", (chunk) => logs.push(chunk)),
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
    expect(transcript).toContain("[session credential redacted]");
  });

  it("removes the host API credential after applying the execution profile", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-command-environment-"));
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const commandRunner: ProcessRunner = {
      async run(options) {
        seenEnv = options.env;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const executionProfiles: ExecutionProfiles = {
      maxConcurrentAssignments: 1,
      profiles: new Map([
        [
          "provider-1",
          { providerAccountId: "provider-1", home: cwd, env: { PROFILE_VALUE: "enabled" } },
        ],
      ]),
    };
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-command-env", "attempt-1", () => undefined),
      [] as never,
      baseAssign({ providerAccountId: "provider-1" }),
      {
        repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
        worktree: { id: "wt-1", name: "wt", path: cwd, labels: [] },
        cwd,
      },
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      {
        HARNESS_API_KEY: "host-secret",
        HARNESS_SESSION_API_KEY: "stale-session-secret",
        HARNESS_SESSION_ID: "stale-session-id",
        HARNESS_CHILD_ENV_ALLOWLIST: "PRESERVED_VALUE",
        PRESERVED_VALUE: "preserved",
      },
      executionProfiles,
    );
    expect(seenEnv).toMatchObject({ PROFILE_VALUE: "enabled", PRESERVED_VALUE: "preserved" });
    expect(seenEnv).not.toHaveProperty("HARNESS_API_KEY");
    expect(seenEnv).not.toHaveProperty("HARNESS_SESSION_API_KEY");
    expect(seenEnv).not.toHaveProperty("HARNESS_SESSION_ID");
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
          return {
            ...result,
            signal: null,
            agentSummary: "Child work was queued with hns_session_ephemeral.",
          };
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
      summary: "Child work was queued with [session credential redacted].",
      summarySource: "agent",
    });
  });
});
