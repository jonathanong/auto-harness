import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("session clone", () => {
  it("copies replayable inputs into a fresh queued session and drops runtime state", () => {
    let id = 0;
    const plane = new ControlPlane({
      idFactory: () => `session-${++id}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 2,
    });
    seedBaseCommand(plane);
    plane.createCommand({
      id: "cmd-fallback",
      name: "fallback",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
    });
    plane.createSession(
      baseSessionBody({
        fallbacks: [{ commandId: "cmd-fallback" }],
        queueTtlSeconds: 60,
        priority: 5,
        requiredLabels: ["codex"],
        ref: "feature/x",
        concurrencyId: "source-lock",
        metadata: { createdBy: "user:source", secret: "must-not-copy" },
      }),
    );
    const source = plane.state.sessions.get("session-1")!;
    Object.assign(source, {
      status: "completed",
      hostId: "host-1",
      worktreeId: "worktree-1",
      resolvedArgv: ["secret-cli-token"],
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd-base",
        hostId: "host-1",
        worktreeId: "worktree-1",
        attemptId: "attempt-1",
      },
      cliResumeRef: "opaque-resume-ref",
      completedAt: "2026-01-01T00:02:00.000Z",
      scheduleId: "schedule-1",
    });

    const result = plane.cloneSession("session-1", { priority: 9, createdBy: "user:clone" });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      session: {
        id: "session-2",
        repositoryId: "repo-1",
        prompt: "do work",
        status: "queued",
        priority: 9,
        requiredLabels: ["codex"],
        ref: "feature/x",
        metadata: { createdBy: "user:clone" },
      },
    });
    if (!result.ok) return;
    expect(result.session.concurrencyId).toBeUndefined();
    expect(result.session.hostId).toBeUndefined();
    expect(result.session.worktreeId).toBeUndefined();
    expect(result.session.resolvedArgv).toBeUndefined();
    expect(result.session.resolvedRoute).toBeUndefined();
    expect(result.session.cliResumeRef).toBeUndefined();
    expect(result.session.scheduleId).toBeUndefined();
  });

  it("also clones an active source safely and rejects invalid overrides", () => {
    const plane = new ControlPlane({ idFactory: () => "session-1" });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    expect(plane.cloneSession("session-1")).toMatchObject({ ok: true, created: true });
    expect(plane.cloneSession("session-1", { timeout: 0 })).toEqual({
      ok: false,
      error: "timeout must be a positive number of seconds",
      code: "VALIDATION_ERROR",
    });
  });
});
