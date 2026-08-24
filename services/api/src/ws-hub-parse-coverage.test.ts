/* eslint-disable max-lines -- protocolVersion/runningAttempts invalid cases. */
import { describe, expect, it } from "vitest";

import { parseHostMessage } from "./ws-hub.ts";

const worktree = {
  id: "wt-1",
  name: "worktree",
  repositoryId: "repo-1",
  path: "/tmp/worktree",
  labels: ["linux"],
};

const registration = {
  type: "host:register",
  hostId: "host-1",
  worktrees: [worktree],
};

describe("parseHostMessage exhaustive wire validation", () => {
  it("accepts every documented message shape and input encoding", () => {
    const status = {
      type: "session:status",
      sessionId: "session-1",
      worktreeId: null,
      attemptId: "attempt-1",
      status: "completed",
      exitCode: null,
      errorCode: "none",
      errorMessage: "done",
      cliResumeRef: "resume-1",
    };
    const log = {
      type: "session:log",
      sessionId: "session-1",
      attemptId: "attempt-1",
      stream: "system",
      content: "done",
      timestamp: "2026-08-11T00:00:00.000Z",
      seq: 0,
    };
    expect(parseHostMessage(JSON.stringify(registration))).toEqual(registration);
    expect(parseHostMessage(Buffer.from(JSON.stringify(registration)))).toEqual(registration);
    expect(
      parseHostMessage({
        ...registration,
        capabilities: ["scheduled-main-checkout"],
        runningSessions: ["session-1"],
        runningAttempts: [{ sessionId: "session-1", attemptId: "attempt-1" }],
        protocolVersion: 1,
        daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
        daemonStartedAt: "2026-08-11T00:00:00.000Z",
        runtime: { daemonVersion: "0.0.0", gitVersion: "2.36.0", gitReady: true },
      }),
    ).toMatchObject({ type: "host:register" });
    expect(
      parseHostMessage({
        type: "session:ack",
        sessionId: "session-1",
        worktreeId: null,
        attemptId: "attempt-1",
      }),
    ).toMatchObject({ type: "session:ack" });
    expect(parseHostMessage(status)).toEqual(status);
    expect(parseHostMessage({ ...status, exitCode: undefined })).toMatchObject({
      ...status,
      exitCode: undefined,
    });
    expect(parseHostMessage({ ...status, exitCode: 0 })).toMatchObject({ exitCode: 0 });
    expect(parseHostMessage(log)).toEqual(log);
    expect(
      parseHostMessage({
        type: "host:keepalive",
        hostId: "host-1",
        at: "2026-08-11T00:00:00.000Z",
      }),
    ).toMatchObject({ type: "host:keepalive" });
  });

  it("rejects invalid envelopes and registration collections", () => {
    const invalid: unknown[] = [
      null,
      1,
      [],
      "{",
      {},
      { type: "x".repeat(65) },
      { ...registration, hostId: "" },
      { ...registration, worktrees: null },
      { ...registration, worktrees: Array.from({ length: 1_001 }, () => worktree) },
      { ...registration, worktrees: [null] },
      { ...registration, worktrees: [[]] },
      { ...registration, worktrees: [{ ...worktree, id: "" }] },
      { ...registration, worktrees: [{ ...worktree, name: "" }] },
      { ...registration, worktrees: [{ ...worktree, repositoryId: "" }] },
      { ...registration, worktrees: [{ ...worktree, path: "x".repeat(4_097) }] },
      { ...registration, worktrees: [{ ...worktree, labels: null }] },
      { ...registration, worktrees: [{ ...worktree, labels: Array(101).fill("x") }] },
      { ...registration, worktrees: [{ ...worktree, labels: [""] }] },
      { ...registration, capabilities: "drain" },
      { ...registration, capabilities: Array(20).fill("scheduled-main-checkout") },
      { ...registration, capabilities: ["unknown"] },
      { ...registration, capabilities: ["scheduled-main-checkout", "scheduled-main-checkout"] },
      { ...registration, runningSessions: "session-1" },
      { ...registration, runningSessions: Array(1_001).fill("session-1") },
      { ...registration, runningSessions: [""] },
      { ...registration, runningAttempts: "session-1" },
      {
        ...registration,
        runningAttempts: Array.from({ length: 1_001 }, () => ({ sessionId: "s", attemptId: "a" })),
      },
      { ...registration, runningAttempts: [{ sessionId: "", attemptId: "a" }] },
      {
        ...registration,
        runningAttempts: [
          { sessionId: "s", attemptId: "a" },
          { sessionId: "s", attemptId: "b" },
        ],
      },
      { ...registration, protocolVersion: -1 },
      { ...registration, protocolVersion: 1.5 },
      { ...registration, protocolVersion: 1_025 },
      { ...registration, daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000" },
      { ...registration, daemonStartedAt: "2026-08-11T00:00:00.000Z" },
      {
        ...registration,
        daemonInstanceId: "not-a-uuid",
        daemonStartedAt: "2026-08-11T00:00:00.000Z",
      },
      { ...registration, runtime: { daemonVersion: "0.0.0", gitVersion: null, gitReady: true } },
      {
        ...registration,
        runtime: {
          daemonVersion: "0.0.0",
          gitVersion: "2.36.0",
          gitReady: true,
          environmentNames: {},
        },
      },
      {
        ...registration,
        runtime: {
          daemonVersion: "0.0.0",
          gitVersion: "2.36.0",
          gitReady: true,
          environmentNames: ["TOKEN", "TOKEN"],
        },
      },
      {
        ...registration,
        runtime: { daemonVersion: "0.0.0", gitVersion: null, gitReady: false },
      },
      {
        ...registration,
        runtime: {
          daemonVersion: "0.0.0",
          gitVersion: null,
          gitReady: false,
          gitReadinessReason: "git_readiness_unreported",
        },
      },
      {
        ...registration,
        daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
        daemonStartedAt: "not-a-time",
      },
    ];
    for (const candidate of invalid) expect(parseHostMessage(candidate)).toBe(null);
  });

  it("rejects invalid acknowledgements, terminal reports, logs, and keepalives", () => {
    const status = {
      type: "session:status",
      sessionId: "session-1",
      worktreeId: "wt-1",
      attemptId: "attempt-1",
      status: "completed",
    };
    const log = {
      type: "session:log",
      sessionId: "session-1",
      attemptId: "attempt-1",
      stream: "stdout",
      content: "ok",
      timestamp: "2026-08-11T00:00:00.000Z",
      seq: 0,
    };
    const invalid: unknown[] = [
      { type: "session:ack", sessionId: "", worktreeId: null, attemptId: "a" },
      { type: "session:ack", sessionId: "s", worktreeId: 1, attemptId: "a" },
      { type: "session:ack", sessionId: "s", worktreeId: null, attemptId: "" },
      { ...status, sessionId: "" },
      { ...status, worktreeId: 1 },
      { ...status, attemptId: "" },
      { ...status, status: "unknown" },
      { ...status, exitCode: 1.5 },
      { ...status, errorCode: 1 },
      { ...status, errorCode: "x".repeat(129) },
      { ...status, errorMessage: 1 },
      { ...status, errorMessage: "x".repeat(4_097) },
      { ...status, cliResumeRef: "bad\0ref" },
      { ...log, sessionId: "" },
      { ...log, attemptId: "" },
      { ...log, stream: "debug" },
      { ...log, content: 1 },
      { ...log, content: "x".repeat(32 * 1_024 + 1) },
      { ...log, timestamp: "" },
      { ...log, timestamp: "not-a-time" },
      { ...log, seq: 1.5 },
      { ...log, seq: -1 },
      { type: "host:keepalive", hostId: "", at: "2026-08-11T00:00:00.000Z" },
      { type: "host:keepalive", hostId: "h", at: "" },
      { type: "host:keepalive", hostId: "h", at: "not-a-time" },
      { type: "not-supported" },
    ];
    for (const candidate of invalid) expect(parseHostMessage(candidate)).toBe(null);
  });
});
