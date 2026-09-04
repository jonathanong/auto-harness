/* eslint-disable max-lines */

import { describe, expect, it } from "vitest";
import { appendPriorContextPointer } from "@auto-harness/shared";

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

type CommandInput = Parameters<ControlPlane["createCommand"]>[0];

/** Create the given Commands, register a single-worktree host, then create, assign, and
 * finish a session against `target`/`fallbacks` (optionally capturing a `cliResumeRef`).
 * Shared by the native-continuation-preference and deleted-Command-replay tests below,
 * which otherwise repeat identical fixture setup before diverging on what happens at
 * resume. */
function startTerminalSession(
  commands: CommandInput[],
  session: { target: { commandId: string }; fallbacks?: Array<{ commandId: string }> },
  cliResumeRef?: string,
): { plane: ControlPlane; messages: unknown[]; sourceId: string } {
  const messages: unknown[] = [];
  const plane = new ControlPlane({ shardCount: 1 });
  plane.setOnHostMessage((_host, message) => messages.push(message));
  for (const command of commands) plane.createCommand(command);
  plane.registerHost({
    hostId: "host",
    worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
    commandProfiles: [],
  });
  const created = plane.createSession({
    repositoryId: "repo",
    prompt: "first",
    timeout: 30,
    target: session.target,
    ...(session.fallbacks ? { fallbacks: session.fallbacks } : {}),
  });
  expect(created.ok).toBe(true);
  const sourceId = created.ok ? created.session.id : "";
  plane.assignQueued();
  acknowledge(plane, sourceId);
  finish(plane, sourceId, "completed", cliResumeRef);
  return { plane, messages, sourceId };
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
    // The Command is edited but not deleted: a native continuation (captured cliResumeRef +
    // frozen resumeArgvTemplate) still uses its frozen snapshot ahead of the edited live
    // Command — deleting it entirely is covered separately (see the "does not replay a
    // deleted Command" tests below, and the terminal-session delete-allowed contract at
    // control-plane-delete-guards.test.ts's "does not preserve terminal session history").
    plane.updateCommand("cmd", {
      argv: ["changed"],
      resumeArgvTemplate: ["changed", "{cliResumeRef}"],
      resumeRefCapture: { stream: "stderr", linePrefix: "changed: " },
    });
    const resumed = plane.resumeSession("s1");
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(assignments()[1]).toMatchObject({
      resolvedArgv: ["codex", "resume", "cli-1", "Continue from the previous session."],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    expect(plane.resumeSession("s1", { prompt: "" }).ok).toBe(false);
    expect(plane.resumeSession("s1", { principalId: 1 } as never)).toEqual({
      ok: false,
      error: "principalId must be a string",
    });
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

  it("upgrades structured output in provider-bound native resume templates, including frozen legacy snapshots", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({
      shardCount: 1,
      idFactory: (() => {
        let n = 0;
        return () => `provider-session-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.setOnHostMessage((_host, message) => messages.push(message));
    expect(
      plane.createProvider({ id: "provider", name: "claude", defaultCommandId: "cmd" }).ok,
    ).toBe(true);
    expect(
      plane.createProviderAccount({ id: "account", providerId: "provider", label: "account" }).ok,
    ).toBe(true);
    plane.createCommand({
      id: "cmd",
      name: "claude",
      argv: ["claude", "-p"],
      providerId: "provider",
      resumeArgvTemplate: ["claude", "-p", "--resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
      providerAccountReadiness: [
        { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    expect(
      plane.putHostInventory("host", {
        repositories: [
          {
            id: "repo",
            path: "/repo",
            worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: [] }],
          },
        ],
        providerAccounts: [{ providerAccountId: "account" }],
        commandProfiles: {},
      }).ok,
    ).toBe(true);
    const source = plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error("unreachable");
    plane.assignQueued();
    expect(plane.state.sessions.get(source.session.id)?.resumeSpec?.resumeArgvTemplate).toEqual([
      "claude",
      "--output-format",
      "json",
      "-p",
      "--resume",
      "{cliResumeRef}",
      "{prompt}",
    ]);
    acknowledge(plane, source.session.id);
    finish(plane, source.session.id, "completed", "cli-1");

    // Simulate a snapshot persisted before provider structured-output migration.
    plane.state.sessions.get(source.session.id)!.resumeSpec!.resumeArgvTemplate = [
      "claude",
      "-p",
      "--resume",
      "{cliResumeRef}",
      "{prompt}",
    ];
    // The Command is left live (not deleted): a native continuation still uses this frozen
    // legacy snapshot ahead of the live Command's current, already-migrated template.
    expect(plane.resumeSession(source.session.id).ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: [
        "claude",
        "--output-format",
        "json",
        "-p",
        "--resume",
        "cli-1",
        "--",
        "Continue from the previous session.",
      ],
    });
  });

  it("carries the authenticated principal across resumed sessions", () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `s${++id}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    const sourceId = created.ok ? created.session.id : "";
    plane.state.sessions.get(sourceId)!.principalId = "creator";
    plane.assignQueued();
    acknowledge(plane, sourceId);
    finish(plane, sourceId);

    const resumed = plane.resumeSession(sourceId);
    expect(resumed).toMatchObject({ ok: true });
    expect(plane.state.sessions.get("s2")).toMatchObject({ principalId: "creator" });
    const overridden = plane.resumeSession(sourceId, { principalId: "operator" });
    expect(overridden).toMatchObject({ ok: true });
    expect(plane.state.sessions.get("s3")).toMatchObject({
      metadata: { createdBy: "operator" },
      principalId: "operator",
    });
  });

  it("recovers the principal from legacy creator metadata", () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `s${++id}`;
      })(),
    });
    plane.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    const sourceId = created.ok ? created.session.id : "";
    const source = plane.state.sessions.get(sourceId)!;
    source.status = "completed";
    source.metadata = { createdBy: "legacy-creator" };
    source.pinnedHostId = "host";
    delete source.principalId;

    expect(plane.resumeSession(sourceId)).toMatchObject({ ok: true });
    expect(plane.state.sessions.get("s2")).toMatchObject({ principalId: "legacy-creator" });
  });

  it("inserts -- before a leading-dash resume prompt in the argv template only when appendPromptSeparator opts in", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({ shardCount: 1 });
    plane.setOnHostMessage((_host, message) => messages.push(message));
    plane.createCommand({
      id: "cmd",
      name: "codex",
      argv: ["codex", "exec"],
      resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
      appendPromptSeparator: true,
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created.ok).toBe(true);
    const sourceId = created.ok ? created.session.id : "";
    plane.assignQueued();
    acknowledge(plane, sourceId);
    finish(plane, sourceId, "completed", "cli-1");
    // Command is left live: the captured cliResumeRef plus frozen resumeArgvTemplate make
    // this a native continuation, which uses the frozen snapshot ahead of live resolution.

    const resumed = plane.resumeSession(sourceId, { prompt: "--dangerously-skip-permissions" });
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: ["codex", "resume", "cli-1", "--", "--dangerously-skip-permissions"],
    });
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
    // No captured cliResumeRef and no resumeArgvTemplate, so this never qualifies as a
    // native continuation (see prefersNativeResumeRoute) — live resolution must actually
    // fail to reach the frozen fallback. Re-point providerId (a soft FK with no eligible
    // accounts) instead of deleting, since deletion is covered by dedicated tests below.
    plane.updateCommand("cmd", { argv: ["changed"], providerId: "unrouted" });

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
    // No cliResumeRef captured and no resumeArgvTemplate, so this stays outside the
    // native-continuation preference — re-point providerId to make live resolution fail
    // instead of deleting the Command (deletion is covered by dedicated tests below).
    plane.updateCommand("cmd", { argv: ["changed"], providerId: "unrouted" });

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

    const paused = new ControlPlane({ shardCount: 1 });
    paused.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    const pausedSource = paused.createSession({
      repositoryId: "repo",
      prompt: "paused",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(pausedSource.ok).toBe(true);
    if (pausedSource.ok) {
      paused.forceStatus(pausedSource.session.id, "completed");
      paused.state.repositories.set("repo", {
        id: "repo",
        name: "repo",
        url: "/repo",
        defaultBranch: "main",
        admissionState: "paused",
        admissionStateChangedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(paused.resumeSession(pausedSource.session.id)).toMatchObject({
        ok: false,
        code: "REPOSITORY_ADMISSION_CLOSED",
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
      expect(overrides.resumeSession(source.session.id, { prompt: "x".repeat(65_536) }).ok).toBe(
        true,
      );
      expect(overrides.resumeSession(source.session.id, { prompt: "x".repeat(65_537) })).toEqual({
        ok: false,
        error: "prompt must be at most 65536 bytes",
      });
      expect(overrides.resumeSession(source.session.id, { timeout: 0 })).toEqual({
        ok: false,
        error: "timeout must be a positive number of seconds",
      });
      expect(overrides.resumeSession(source.session.id, { timeout: Number.NaN })).toEqual({
        ok: false,
        error: "timeout must be a positive number of seconds",
      });
      expect(overrides.resumeSession(source.session.id, { timeout: 604_801 })).toEqual({
        ok: false,
        error: "timeout must be at most 604800 seconds",
      });
      expect(overrides.resumeSession(source.session.id, { timeout: 604_800 })).toMatchObject({
        ok: true,
        session: { timeout: 604_800 },
      });
      expect(
        overrides.resumeSession(source.session.id, { priority: Number.POSITIVE_INFINITY }),
      ).toEqual({
        ok: false,
        error: "priority must be a number",
      });
      expect(overrides.resumeSession(source.session.id, { priority: 0.5 })).toEqual({
        ok: false,
        error: "priority must be an integer",
      });
      expect(overrides.resumeSession(source.session.id, { priority: 5 })).toMatchObject({
        ok: true,
        session: { priority: 5 },
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

  it("returns an already-active session sharing the source's concurrencyId instead of resuming (in-memory path)", () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({ id: "cmd", name: "tool", argv: ["tool"] });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    const source = plane.createSession({
      repositoryId: "repo",
      prompt: "first",
      target: { commandId: "cmd" },
      timeout: 30,
      concurrencyId: "resume-key",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    plane.assignQueued();
    plane.forceStatus(source.session.id, "completed");
    // Only the process cache (no storage backend) makes this branch reachable —
    // simulate a second worker's active session already holding this identity.
    plane.state.sessions.set("active-elsewhere", {
      ...plane.state.sessions.get(source.session.id)!,
      id: "active-elsewhere",
      status: "queued",
    });
    expect(plane.resumeSession(source.session.id)).toMatchObject({
      ok: true,
      created: false,
      session: { id: "active-elsewhere" },
    });
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

  it("does not replay a deleted primary Command's frozen snapshot; falls through to a live fallback", () => {
    const { plane, messages, sourceId } = startTerminalSession(
      [
        { id: "primary", name: "primary", argv: ["primary"] },
        { id: "fallback", name: "fallback", argv: ["fallback"] },
      ],
      { target: { commandId: "primary" }, fallbacks: [{ commandId: "fallback" }] },
      "cli-1",
    );

    // Source is terminal, so deletion is allowed even though it is still resumable —
    // this is the invalidation lever #402/#438 asked for.
    expect(plane.deleteCommand("primary").ok).toBe(true);

    const resumed = plane.resumeSession(sourceId);
    expect(resumed.ok).toBe(true);
    expect(plane.assignQueued()).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      commandId: "fallback",
      targetIndex: 1,
      resumedFromSessionId: sourceId,
    });
    expect(messages.at(-1)).not.toHaveProperty("resume");
    expect(messages.at(-1)).not.toHaveProperty("cliResumeRef");
  });

  it("does not replay a deleted Command's frozen snapshot when nothing else resolves", () => {
    const { plane, sourceId } = startTerminalSession(
      [{ id: "cmd", name: "cmd", argv: ["cmd"] }],
      { target: { commandId: "cmd" } },
      "cli-1",
    );
    expect(plane.deleteCommand("cmd").ok).toBe(true);

    const resumed = plane.resumeSession(sourceId);
    expect(resumed.ok).toBe(true);
    expect(plane.assignQueued()).toEqual([]);
  });

  it("prefers the frozen resumeArgvTemplate over a live, untouched Command", () => {
    // The Command is entirely untouched — regression test for the ordering bug where a
    // native continuation with a captured ref and a frozen template was silently given
    // the plain command argv (starting a *new* CLI conversation) whenever live resolution
    // still happened to succeed.
    const { plane, messages, sourceId } = startTerminalSession(
      [
        {
          id: "cmd",
          name: "codex",
          argv: ["codex", "exec"],
          resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
        },
      ],
      { target: { commandId: "cmd" } },
      "cli-1",
    );

    const resumed = plane.resumeSession(sourceId);
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: ["codex", "resume", "cli-1", "Continue from the previous session."],
    });
  });

  it("resolves a resumeFallback continuation with no template live, picking up a catalog edit", () => {
    // No cliResumeRef captured: this resume has no native continuation to make, so
    // prefersNativeResumeRoute must stay false and live resolution — including the edit
    // below — must still win, unlike the native-continuation case above.
    const { plane, messages, sourceId } = startTerminalSession(
      [{ id: "cmd", name: "tool", argv: ["tool", "run"] }],
      { target: { commandId: "cmd" } },
    );
    plane.updateCommand("cmd", { argv: ["edited", "run"] });

    const resumed = plane.resumeSession(sourceId);
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      resolvedArgv: ["edited", "run", "Continue from the previous session."],
    });
  });

  it("clears the pin instead of silently reusing a live route when the frozen template fails validation", () => {
    const { plane, messages, sourceId } = startTerminalSession(
      [
        {
          id: "cmd",
          name: "codex",
          argv: ["codex", "exec"],
          resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
        },
      ],
      { target: { commandId: "cmd" } },
      "cli-1",
    );
    // The live Command is untouched and would resolve fine on its own; only the
    // *frozen* snapshot on the terminal source session is corrupted here, simulating a
    // legacy snapshot that no longer passes validateCommandResumeSpec (two {cliResumeRef}
    // placeholders). Falling through to the live route in this state would send
    // `resume: true` plus the stale cliResumeRef while executing plain live argv, instead
    // of invalidating the pin and routing fresh.
    plane.state.sessions.get(sourceId)!.resumeSpec!.resumeArgvTemplate = [
      "codex",
      "resume",
      "{cliResumeRef}",
      "{cliResumeRef}",
    ];

    const resumed = plane.resumeSession(sourceId);
    expect(resumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      // clear_pin appends the prior-context pointer to the prompt (see
      // clearResumePin) — confirming this is the fresh-fallback path, not a
      // coincidentally pin-matching live route.
      resolvedArgv: [
        "codex",
        "exec",
        appendPriorContextPointer("Continue from the previous session."),
      ],
    });
    expect(messages.at(-1)).not.toHaveProperty("resume");
    expect(messages.at(-1)).not.toHaveProperty("cliResumeRef");
  });

  it("replaces the frozen snapshot instead of leaking a deleted Command's template onto its live fallback", () => {
    const { plane, messages, sourceId } = startTerminalSession(
      [
        {
          id: "primary",
          name: "primary",
          argv: ["primary", "run"],
          resumeArgvTemplate: ["primary", "resume", "{cliResumeRef}", "{prompt}"],
        },
        {
          id: "fallback",
          name: "fallback",
          argv: ["fallback", "run"],
          resumeArgvTemplate: ["fallback", "resume", "{cliResumeRef}", "{prompt}"],
        },
      ],
      { target: { commandId: "primary" }, fallbacks: [{ commandId: "fallback" }] },
      "cli-1",
    );
    expect(plane.deleteCommand("primary").ok).toBe(true);

    // Falls through to the live fallback (proven separately above); this fallback run
    // itself then captures a fresh native-resume reference.
    const firstResumed = plane.resumeSession(sourceId);
    expect(firstResumed.ok).toBe(true);
    const fallbackId = firstResumed.ok ? firstResumed.session.id : "";
    plane.assignQueued();
    acknowledge(plane, fallbackId);
    finish(plane, fallbackId, "completed", "cli-2");

    // A later resume of the fallback run must use *its own* frozen template — not
    // primary's, which the write-once resumeSpec field would otherwise have kept
    // attached across the fallback despite resolvedRoute.commandId already saying
    // "fallback".
    const secondResumed = plane.resumeSession(fallbackId);
    expect(secondResumed.ok).toBe(true);
    plane.assignQueued();
    expect(messages.at(-1)).toMatchObject({
      type: "session:assign",
      commandId: "fallback",
      resolvedArgv: ["fallback", "resume", "cli-2", "Continue from the previous session."],
    });
  });
});
