/* eslint-disable max-lines -- focused schedule/session edge matrices share compact fixtures. */
import { describe, expect, it, vi } from "vitest";

import type { Principal } from "./auth.ts";
import {
  setDurableReadStorage,
  setInMemoryScheduleStorage,
} from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import {
  cloneSessionDurable,
  createSessionDurable,
  resumeSessionDurable,
} from "./control-plane-sessions-durable.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { ControlPlane } from "./control-plane.ts";
import { putSchedule, putScheduleDurable, updateSchedule } from "./control-plane-schedules.ts";
import { tryClaimScheduleFireDurable } from "./control-plane-schedule-fire.ts";
import {
  createWorkspacePool,
  createWorkspacePoolDurable,
  deleteWorkspacePoolDurable,
  getWorkspacePoolDurable,
  listWorkspacePoolsDurable,
  listWorkspacePoolsPublic,
  updateWorkspacePool,
  updateWorkspacePoolDurable,
} from "./control-plane-workspace-pools.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { createResumeRouteFixture } from "../test-helpers/local-server-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";
import { createLocalApp } from "./local-server.ts";
import { handleRepositoryRoutes } from "./local-routes-repos-schedules.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function commandState() {
  const state = createControlPlaneState({ idFactory: () => "new-session", now: () => NOW });
  state.repositories.set("repo", {
    id: "repo",
    name: "repo",
    url: "https://example.test/repo.git",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });
  state.commands.set("cmd", {
    id: "cmd",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  return state;
}

function source(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "source",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    cliResumeRef: "resume-ref",
    type: "prompt",
    source: "api",
    ...over,
  };
}

describe("schedule and durable session edge matrices", () => {
  it("uses the local create/resume/clone fallbacks when storage is absent", async () => {
    const state = commandState();
    const created = await createSessionDurable(state, {
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    expect(created).toMatchObject({ ok: true, created: true });
    if (!created.ok) return;
    const row = state.sessions.get(created.session.id)!;
    row.status = "completed";
    row.hostId = "host";
    expect(await resumeSessionDurable(state, row.id)).toMatchObject({ ok: true, created: true });
    expect(await cloneSessionDurable(state, row.id)).toMatchObject({ ok: true, created: true });
  });

  it("covers durable create outcomes and authoritative resume outcomes", async () => {
    const state = commandState();
    const persisted = vi.fn(async (row: SessionRecord) => ({
      session: row,
      created: true as const,
    }));
    setDurableReadStorage(state, { createSession: persisted });
    await expect(
      createSessionDurable(state, {
        repositoryId: "repo",
        prompt: "durable",
        target: { commandId: "cmd" },
        timeout: 30,
      }),
    ).resolves.toMatchObject({ ok: true, created: true });

    const resumeSource = source();
    state.sessions.set(resumeSource.id, resumeSource);
    state.storage!.createSession = persisted;
    await expect(resumeSessionDurable(state, resumeSource.id)).resolves.toMatchObject({
      ok: true,
      created: true,
      session: { resumedFromSessionId: "source" },
    });

    const conflict = Object.assign(new Error("collision"), { name: "SessionIdCollisionError" });
    state.storage!.createSession = async () => {
      throw conflict;
    };
    await expect(resumeSessionDurable(state, resumeSource.id)).resolves.toMatchObject({
      ok: false,
      error: "session creation conflicted; retry the request",
    });
  });

  it("covers schedule validation alternatives and active-session projection", () => {
    const state = commandState();
    expect(
      putSchedule(state, {
        repositoryId: "repo",
        name: "bad",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
        setupScript: "not allowed",
      } as never),
    ).toMatchObject({ ok: false });
    expect(
      putSchedule(state, {
        repositoryId: null,
        workspacePoolId: "missing",
        name: "workspace",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).toEqual({ ok: false, error: "workspace pool not found" });
    expect(
      putSchedule(state, {
        repositoryId: "repo",
        name: "bad-ref",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
        ref: "refs/tags/v1",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("ref") });
    const invalidModes = [
      { repositoryId: "repo", requiredLabels: "labels" },
      { repositoryId: "repo", requiredLabels: ["label"] },
      { repositoryId: 1 },
      { repositoryId: "repo", workspacePoolId: "pool" },
      { repositoryId: null, workspacePoolId: "" },
      { repositoryId: null, workspacePoolId: "missing", ref: "main" },
      { repositoryId: null, workspacePoolId: "missing", setupProfileId: "" },
      { repositoryId: null, workspacePoolId: "missing", destroyWorkspaceAfter: "yes" },
    ];
    for (const mode of invalidModes) {
      expect(
        putSchedule(state, {
          ...mode,
          name: "invalid-mode",
          target: { commandId: "cmd" },
          cron: "* * * * *",
          timeout: 30,
        } as never),
      ).toMatchObject({ ok: false });
    }
    createWorkspacePool(state, {
      id: "pool",
      name: "pool",
      setupProfiles: [{ id: "setup", name: "Setup", script: "echo" }],
      destroyWorkspaceAfter: true,
    });
    expect(
      putSchedule(state, {
        repositoryId: null,
        workspacePoolId: "pool",
        setupProfileId: "missing",
        name: "missing-profile",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).toMatchObject({ ok: false, error: "workspace setup profile not found" });
    expect(
      putSchedule(state, {
        repositoryId: null,
        workspacePoolId: "pool",
        name: "workspace-valid",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).toMatchObject({ ok: true });
    const saved = putSchedule(state, {
      repositoryId: "repo",
      id: "schedule",
      name: "good",
      target: { commandId: "cmd" },
      cron: "* * * * *",
      timeout: 30,
    });
    expect(saved).toMatchObject({ ok: true });
    state.sessions.set("active", {
      id: "active",
      concurrencyId: "schedule-schedule",
      status: "running",
    } as never);
    expect(state.schedules.get("schedule") && updateSchedule(state, "schedule", {})).toMatchObject({
      ok: true,
    });
  });

  it("covers workspace-pool profile and public projection alternatives", () => {
    const state = commandState();
    expect(createWorkspacePool(state, { name: "bad name" })).toMatchObject({ ok: false });
    expect(
      createWorkspacePool(state, {
        name: "pool",
        setupProfiles: [{ id: "bad id", name: "Bad", script: "echo" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      createWorkspacePool(state, {
        name: "pool",
        setupProfiles: [{ id: "setup", name: "Setup", script: "echo" }],
        defaultSetupProfileId: "missing",
      }),
    ).toMatchObject({ ok: false });
    const created = createWorkspacePool(state, {
      name: "pool",
      setupProfiles: [{ id: "setup", name: "Setup", script: "echo" }],
      defaultSetupProfileId: "setup",
    });
    expect(created).toMatchObject({ ok: true });
    expect(listWorkspacePoolsPublic(state)).toEqual([
      {
        id: expect.any(String),
        name: "pool",
        setupProfiles: [{ id: "setup", name: "Setup" }],
        defaultSetupProfileId: "setup",
        destroyWorkspaceAfter: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(updateWorkspacePool(state, "missing", { name: "other" })).toEqual({
      ok: false,
      error: "workspace pool not found",
    });
    expect(
      updateWorkspacePool(state, created.ok ? created.workspacePool.id : "pool", {
        name: "bad name",
      }),
    ).toMatchObject({ ok: false });
  });

  it("covers durable schedule update fallback and no-storage schedule paths", async () => {
    const state = commandState();
    const saved = putSchedule(state, {
      repositoryId: "repo",
      id: "schedule",
      name: "schedule",
      target: { commandId: "cmd" },
      cron: "* * * * *",
      timeout: 30,
    });
    expect(saved.ok).toBe(true);
    expect(
      await putScheduleDurable(state, {
        repositoryId: "repo",
        id: "second",
        name: "second",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).toMatchObject({ ok: true });
    setInMemoryScheduleStorage(state, {
      updateScheduleManagement: async () => null,
      getSchedule: async () => null,
    });
    // The management wrapper re-reads and removes a schedule that lost its CAS.
    const { updateScheduleDurable } = await import("./control-plane-schedules-durable.ts");
    await expect(
      updateScheduleDurable(state, "schedule", { name: "updated" }),
    ).resolves.toMatchObject({
      ok: false,
      error: "schedule not found",
    });
  });

  it("executes each durable workspace-pool operation against a small storage double", async () => {
    const state = commandState();
    const pool = {
      id: "durable-pool",
      name: "durable-pool",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const storage = {
      listWorkspacePools: vi.fn(async () => [pool]),
      createWorkspacePool: vi.fn(async () => true),
      getWorkspacePool: vi.fn(async () => pool),
      updateWorkspacePool: vi.fn(async () => true),
      deleteWorkspacePool: vi.fn(async () => undefined),
      acquireDeletionMarker: vi.fn(async () => true),
      renewDeletionMarker: vi.fn(async () => true),
      releaseDeletionMarker: vi.fn(async () => true),
    };
    setDurableReadStorage(state, storage);
    await expect(listWorkspacePoolsDurable(state)).resolves.toEqual([pool]);
    await expect(getWorkspacePoolDurable(state, pool.id)).resolves.toEqual(pool);
    await expect(createWorkspacePoolDurable(state, { name: "new-pool" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      updateWorkspacePoolDurable(state, pool.id, { name: "renamed-pool" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(deleteWorkspacePoolDurable(state, pool.id)).resolves.toEqual({ ok: true });
  });

  it("covers repository list pagination validation and scoped queries", async () => {
    const plane = new ControlPlane();
    plane.listRepositoriesPageDurable = async (options) => ({
      items: [{ id: "repo", name: "repo" } as never],
      nextCursor: options.limit === 1 ? "next" : null,
    });
    plane.listRepositoryCountsDurable = async () => new Map();
    const handler = createLocalApp({ plane }).handler;
    const invoke = (path: string, principal?: Principal) =>
      invokeHandler(
        (req, res) =>
          handleRepositoryRoutes({
            plane,
            req,
            res,
            url: new URL(path, "http://localhost"),
            method: "GET",
            ...(principal ? { principal } : {}),
          }),
        "GET",
        path,
      );
    for (const path of [
      "/api/v1/repositories?limit=0",
      "/api/v1/repositories?limit=101",
      "/api/v1/repositories?limit=abc",
      "/api/v1/repositories?limit=1&limit=2",
      "/api/v1/repositories?cursor=",
      "/api/v1/repositories?cursor=a&cursor=b",
    ]) {
      expect((await invokeHandler(handler, "GET", path)).status).toBe(400);
    }
    expect((await invokeHandler(handler, "GET", "/api/v1/repositories?limit=1")).status).toBe(200);
    expect(
      (
        await invoke("/api/v1/repositories?limit=1", {
          id: "scoped",
          kind: "service-account",
          role: "operator",
          allowedRepositoryIds: ["repo"],
        })
      ).status,
    ).toBe(200);
  });

  it("audits principal-drain fires and fences duplicate active concurrency", async () => {
    const state = commandState();
    state.schedules.set("schedule", {
      id: "schedule",
      repositoryId: "repo",
      principalId: "principal",
      name: "schedule",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      queueTtlSeconds: 60,
      nextRunAt: NOW,
      lastRunAt: null,
      createdAt: NOW,
      concurrencyId: "schedule-schedule",
    });
    setInMemoryScheduleStorage(state, {
      tryClaimScheduleAndCreateSession: async () => ({
        kind: "draining",
        operationId: "drain-1",
      }),
      skipScheduleForPrincipalDrainAndAudit: async () => true,
    });
    await expect(tryClaimScheduleFireDurable(state, "schedule", NOW, NOW)).resolves.toBeNull();
    expect(state.auditLogs.size).toBe(1);

    state.schedules.get("schedule")!.nextRunAt = NOW;
    setInMemoryScheduleStorage(state, {
      tryClaimScheduleAndCreateSession: async () => ({
        kind: "duplicate",
        session: { id: "existing", repositoryId: "repo", status: "running" },
      }),
      skipScheduleForActiveConcurrency: async () => true,
    });
    await expect(tryClaimScheduleFireDurable(state, "schedule", NOW, NOW)).resolves.toBeNull();
    expect(state.sessions.has("existing")).toBe(true);
  });

  it("covers durable cancellation success and lost-CAS outcomes", async () => {
    const state = commandState();
    state.sessions.set("queued", source({ id: "queued", status: "queued", hostId: undefined }));
    const cancelQueued = vi.fn(async () => true);
    setDurableReadStorage(state, { cancelQueuedSession: cancelQueued });
    await expect(cancelSessionDurable(state, "queued")).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
    expect(cancelQueued).toHaveBeenCalled();

    state.sessions.set("lost", source({ id: "lost", status: "queued" }));
    state.storage!.cancelQueuedSession = async () => false;
    await expect(cancelSessionDurable(state, "lost")).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });

    state.sessions.set(
      "running",
      source({
        id: "running",
        status: "running",
        worktreeId: "worktree",
        assignmentConnectionId: "connection",
        attemptId: "attempt",
        principalId: "principal",
      }),
    );
    state.storage!.cancelRunningSession = async () => true;
    await expect(
      cancelSessionDurable(state, "running", { drainOperationId: "drain" }),
    ).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
    expect(state.sessions.get("running")?.cancelledByDrainOperationId).toBe("drain");
  });

  it("exercises resume route coarse validation and categorized durable outcomes", async () => {
    const fixture = await createResumeRouteFixture();
    const created = await fixture.invoke(
      "/api/v1/sessions",
      { repositoryId: "repo", prompt: "run", target: { commandId: "command" }, timeout: 30 },
      fixture.accounts[0]!.apiKey,
    );
    const id = (created.json as { id: string }).id;
    Object.assign(fixture.plane.state.sessions.get(id)!, { status: "completed", hostId: "host" });
    for (const body of [
      { prompt: "" },
      { timeout: Number.NaN },
      { priority: "high" },
      { concurrencyId: "wrong" },
      { fallbacks: "wrong" },
      { unknown: true },
    ]) {
      expect(
        (await fixture.invoke(`/api/v1/sessions/${id}/resume`, body, fixture.accounts[0]!.apiKey))
          .status,
      ).toBe(400);
    }
    fixture.plane.resumeSessionDurable = async () => ({
      ok: false,
      error: "session already terminal: completed",
    });
    expect(
      (await fixture.invoke(`/api/v1/sessions/${id}/resume`, {}, fixture.accounts[0]!.apiKey))
        .status,
    ).toBe(409);
  });
});
