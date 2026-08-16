/* eslint-disable max-lines */

import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

function acknowledge(plane: ControlPlane, sessionId: string): void {
  const session = plane.getSession(sessionId)!;
  plane.handleHostMessage({
    type: "session:ack",
    sessionId,
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
  });
}

function finish(
  plane: ControlPlane,
  sessionId: string,
  status: "completed" | "cancelled" = "completed",
  cliResumeRef?: string,
): void {
  const session = plane.getSession(sessionId)!;
  plane.handleHostMessage({
    type: "session:status",
    sessionId,
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
    status,
    ...(cliResumeRef ? { cliResumeRef } : {}),
  });
}

describe("control-plane native resume", () => {
  it("snapshots the command resume spec and materializes native argv", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({
      shardCount: 1,
      idFactory: (() => {
        let n = 0;
        return () => `s${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.setOnHostMessage((_host, message) => messages.push(message));
    plane.createCommand({
      id: "cmd",
      name: "codex",
      argv: ["codex", "exec"],
      resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    plane.assignQueued();
    const assignments = () =>
      messages.filter((message) => (message as { type?: string }).type === "session:assign");
    expect(assignments()[0]).toMatchObject({
      resolvedArgv: ["codex", "exec", "first"],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    acknowledge(plane, "s1");
    finish(plane, "s1", "completed", "cli-1");
    plane.updateCommand("cmd", {
      argv: ["changed"],
      resumeArgvTemplate: ["changed", "{cliResumeRef}"],
      resumeRefCapture: { stream: "stderr", linePrefix: "changed: " },
    });
    expect(plane.deleteCommand("cmd").ok).toBe(true);
    const resumed = plane.resumeSession("s1");
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(assignments()[1]).toMatchObject({
      resolvedArgv: ["codex", "resume", "cli-1", "Continue from the previous session."],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    expect(plane.resumeSession("s1", { prompt: "" }).ok).toBe(false);
    expect(plane.resumeSession("s1", { prompt: 1 } as never).ok).toBe(false);
    expect(plane.resumeSession("s1", { timeout: 0 }).ok).toBe(false);
    expect(plane.resumeSession("s1", { timeout: "slow" } as never).ok).toBe(false);
    expect(plane.resumeSession("s1", { timeout: Number.NaN }).ok).toBe(false);
    expect(plane.resumeSession("s1", { priority: Number.NaN }).ok).toBe(false);
    expect(plane.resumeSession("s1", { priority: "high" } as never).ok).toBe(false);
    const source = plane.state.sessions.get("s1")!;
    source.type = "scheduled";
    expect(plane.resumeSession("s1").ok).toBe(false);
    source.type = "prompt";
    source.hostId = null;
    source.pinnedHostId = null;
    expect(plane.resumeSession("s1").ok).toBe(true);
  });

  it("uses the frozen normal command with a continuation override when native resume is absent", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({ shardCount: 1 });
    plane.setOnHostMessage((_host, message) => messages.push(message));
    plane.createCommand({ id: "cmd", name: "tool", argv: ["tool", "run"] });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: ["tool"],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "original",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    const sourceId = created.ok ? created.session.id : "";
    plane.assignQueued();
    acknowledge(plane, sourceId);
    finish(plane, sourceId);
    plane.updateCommand("cmd", { argv: ["changed"] });
    expect(plane.deleteCommand("cmd").ok).toBe(true);

    const resumed = plane.resumeSession(sourceId, { prompt: "continue here" });
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: ["tool", "run", "continue here"],
    });
    const resumedId = resumed.ok ? resumed.session.id : "";
    acknowledge(plane, resumedId);
    finish(plane, resumedId);
    const source = plane.state.sessions.get(sourceId)!;
    source.resumeSpec = { argv: ["tool", "plain"], appendPrompt: false };
    expect(plane.resumeSession(sourceId, { prompt: "not appended" }).ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({ resolvedArgv: ["tool", "plain"] });
  });

  it("inserts -- in the frozen native-resume-pin fallback only when appendPromptSeparator opts in", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({ shardCount: 1 });
    plane.setOnHostMessage((_host, message) => messages.push(message));
    plane.createCommand({
      id: "cmd",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPromptSeparator: true,
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: ["claude-print"],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "original",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    const sourceId = created.ok ? created.session.id : "";
    plane.assignQueued();
    acknowledge(plane, sourceId);
    finish(plane, sourceId);
    plane.updateCommand("cmd", { argv: ["changed"] });
    expect(plane.deleteCommand("cmd").ok).toBe(true);

    const resumed = plane.resumeSession(sourceId, { prompt: "--dangerously-skip-permissions" });
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: ["claude", "-p", "--", "--dangerously-skip-permissions"],
    });
  });

  it("rejects non-terminal sources and native resumes without a captured reference", () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({
      id: "cmd",
      name: "tool",
      argv: ["tool"],
      resumeArgvTemplate: ["tool", "resume", "{cliResumeRef}"],
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "original",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    const sourceId = created.ok ? created.session.id : "";
    expect(plane.resumeSession(sourceId)).toMatchObject({ ok: false });
    plane.assignQueued();
    acknowledge(plane, sourceId);
    finish(plane, sourceId);
    expect(plane.resumeSession(sourceId)).toEqual({
      ok: false,
      error: "source session has no captured CLI resume reference",
    });
  });

  it("retains host affinity and a captured reference from a late cancelled status", () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({
      id: "cmd",
      name: "tool",
      argv: ["tool"],
      resumeArgvTemplate: ["tool", "resume", "{cliResumeRef}"],
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "original",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    const sourceId = created.ok ? created.session.id : "";
    plane.assignQueued();
    acknowledge(plane, sourceId);
    plane.cancelSession(sourceId);
    finish(plane, sourceId, "cancelled", "native-ref");
    expect(plane.getSession(sourceId)).toMatchObject({
      hostId: "host",
      worktreeId: null,
      cliResumeRef: "native-ref",
    });
    expect(plane.resumeSession(sourceId).ok).toBe(true);
  });

  it("rejects missing, non-terminal, scheduled, and invalid override sources", () => {
    const missing = new ControlPlane({ shardCount: 1 });
    expect(missing.resumeSession("missing")).toEqual({ ok: false, error: "session not found" });

    const nonTerminal = new ControlPlane({ shardCount: 1 });
    nonTerminal.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    const queued = nonTerminal.createSession({
      repositoryId: "repo",
      prompt: "queued",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(queued.ok).toBe(true);
    if (queued.ok) {
      expect(nonTerminal.resumeSession(queued.session.id)).toEqual({
        ok: false,
        error: "source session must be terminal before resume",
      });
    }

    const scheduled = new ControlPlane({
      shardCount: 1,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    scheduled.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    expect(
      scheduled.putSchedule({
        repositoryId: "repo",
        name: "nightly",
        target: { commandId: "cmd" },
        cron: "0 * * * *",
        timeout: 30,
        nextRunAt: "2026-01-01T00:00:00.000Z",
        enabled: true,
      }).ok,
    ).toBe(true);
    expect(scheduled.evaluateCron("2026-01-01T01:00:00.000Z")).toHaveLength(1);
    const scheduledSession = scheduled.listSessions()[0]!;
    scheduled.forceStatus(scheduledSession.id, "completed");
    expect(scheduled.resumeSession(scheduledSession.id)).toEqual({
      ok: false,
      error: "scheduled sessions do not support worktree resume",
    });

    const noAgent = new ControlPlane({ shardCount: 1 });
    noAgent.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    const unpinned = noAgent.createSession({
      repositoryId: "repo",
      prompt: "unpinned",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(unpinned.ok).toBe(true);
    if (unpinned.ok) {
      noAgent.forceStatus(unpinned.session.id, "completed");
      expect(noAgent.resumeSession(unpinned.session.id)).toEqual({
        ok: false,
        error: "source session has no agent to pin",
      });
    }

    const overrides = new ControlPlane({ shardCount: 1 });
    overrides.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    overrides.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const source = overrides.createSession({
      repositoryId: "repo",
      prompt: "source",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(source.ok).toBe(true);
    if (source.ok) {
      overrides.assignQueued();
      acknowledge(overrides, source.session.id);
      finish(overrides, source.session.id);
      expect(overrides.resumeSession(source.session.id, { prompt: "" })).toEqual({
        ok: false,
        error: "prompt must be a non-empty string",
      });
      expect(overrides.resumeSession(source.session.id, { timeout: 0 })).toEqual({
        ok: false,
        error: "timeout must be a positive number of seconds",
      });
      expect(overrides.resumeSession(source.session.id, { timeout: Number.NaN })).toEqual({
        ok: false,
        error: "timeout must be a positive number of seconds",
      });
      expect(
        overrides.resumeSession(source.session.id, { priority: Number.POSITIVE_INFINITY }),
      ).toEqual({
        ok: false,
        error: "priority must be a number",
      });
      expect(
        overrides.resumeSession(source.session.id, { pinExpiresAt: "not-a-timestamp" }),
      ).toEqual({
        ok: false,
        error: "pinExpiresAt must be a valid timestamp",
      });
      const validExpiry = overrides.resumeSession(source.session.id, {
        pinExpiresAt: "2026-01-01T01:00:00.000Z",
      });
      expect(validExpiry).toMatchObject({
        ok: true,
        session: { pinExpiresAt: "2026-01-01T01:00:00.000Z" },
      });
    }
  });

  it("uses the frozen argv without appending a prompt when resuming a command", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({ shardCount: 1 });
    plane.setOnHostMessage((_host, message) => messages.push(message));
    plane.createCommand({ id: "cmd", name: "tool", argv: ["tool", "run"], appendPrompt: false });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: ["tool"],
    });
    const source = plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error("unreachable");
    plane.assignQueued();
    acknowledge(plane, source.session.id);
    finish(plane, source.session.id);
    const resumed = plane.resumeSession(source.session.id);
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: ["tool", "run"],
    });
  });

  it("skips an assignment when its referenced command has been removed", () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "orphan",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    // This is an externally-corrupted catalog row, not a supported delete:
    // delete guards intentionally reject removal while the session is queued.
    plane.state.commands.delete("cmd");
    expect(plane.assignQueued()).toEqual([]);
  });
});
