/* eslint-disable max-lines */
import { beforeAll, describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx, putActiveTestRepository } from "./db/dynamo-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const ctx = createDynamoTestCtx("PrincipalDrain");

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function session(
  id: string,
  repositoryId: string,
  principalId: string,
  over: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    repositoryId,
    principalId,
    prompt: "drain me",
    target: { commandId: "command-drain" },
    fallbacks: [],
    targetLabels: ["drain command"],
    queueTtlSeconds: 691200,
    queueExpiresAt: "2026-01-09T00:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeAll(async () => {
  if (!ctx.storage) return;
  await putActiveTestRepository(ctx.storage, "repo-drain");
  await ctx.storage.putCommand({
    id: "command-drain",
    name: "drain command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("principal-scoped durable session drains", () => {
  it("fences only the authenticated principal and retains terminal operation proof", async () => {
    if (!ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    let sessionNumber = 0;
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => `principal-drain-session-${++sessionNumber}`,
      sessionDrainIdFactory: () => "principal-drain-operation",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    const auth = new AuthService({
      mode: "required",
      secret: "d".repeat(32),
      admins: admins(),
    });
    const principalA = await auth.createServiceAccount({
      name: "filaments-a",
      role: "operator",
      allowedRepositoryIds: ["repo-drain"],
    });
    const principalB = await auth.createServiceAccount({
      name: "filaments-b",
      role: "operator",
      allowedRepositoryIds: ["repo-drain"],
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (method: string, path: string, body: unknown, apiKey: string) =>
      invokeHandler(handler, method, path, body, { authorization: `Bearer ${apiKey}` });
    const createBody = {
      repositoryId: "repo-drain",
      prompt: "integrate filaments",
      target: { commandId: "command-drain" },
      timeout: 30,
      metadata: { createdBy: principalB.account.id },
    };

    const initial = await invoke("POST", "/api/v1/sessions", createBody, principalA.apiKey);
    expect(initial.status).toBe(201);
    const initialId = (initial.json as { id: string }).id;
    expect(await ctx.storage.getSession(initialId)).toMatchObject({
      principalId: principalA.account.id,
      metadata: { createdBy: principalA.account.id },
    });

    const started = await invoke(
      "POST",
      "/api/v1/repositories/repo-drain/session-drains",
      {},
      principalA.apiKey,
    );
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({
      operationId: "principal-drain-operation",
      repositoryId: "repo-drain",
      status: "succeeded",
      cancelledCount: 1,
    });
    expect((await ctx.storage.getSession(initialId))?.status).toBe("cancelled");

    const replay = await invoke(
      "POST",
      "/api/v1/repositories/repo-drain/session-drains",
      {},
      principalA.apiKey,
    );
    expect(replay.status).toBe(202);
    expect(replay.json).toMatchObject({
      operationId: "principal-drain-operation",
      status: "succeeded",
    });

    const fenced = await invoke("POST", "/api/v1/sessions", createBody, principalA.apiKey);
    expect(fenced.status).toBe(409);
    expect(fenced.json).toMatchObject({
      error: {
        code: "DRAINING",
        operationId: "principal-drain-operation",
        statusUrl: "/api/v1/repositories/repo-drain/session-drains/principal-drain-operation",
      },
    });

    await ctx.storage.putSession(
      session("principal-drain-source", "repo-drain", principalA.account.id, {
        status: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command-drain",
          hostId: "source-host",
          worktreeId: "source-worktree",
          attemptId: "source-attempt",
        },
      }),
    );
    const crossPrincipalResume = await invoke(
      "POST",
      "/api/v1/sessions/principal-drain-source/resume",
      {},
      principalB.apiKey,
    );
    expect(crossPrincipalResume.status).toBe(403);
    expect(crossPrincipalResume.json).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    await expect(
      plane.cloneSessionDurable("principal-drain-source", {
        createdBy: principalA.account.id,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "DRAINING",
      operationId: "principal-drain-operation",
    });
    const resumeResult = await plane.resumeSessionDurable("principal-drain-source", {
      principalId: principalA.account.id,
    });
    expect(resumeResult).toMatchObject({
      ok: false,
      code: "DRAINING",
      operationId: "principal-drain-operation",
    });
    expect(
      await plane.putScheduleDurable({
        id: "principal-drain-schedule",
        repositoryId: "repo-drain",
        principalId: principalA.account.id,
        name: "principal drain",
        target: { commandId: "command-drain" },
        cron: "* * * * *",
        timeout: 30,
        nextRunAt: "2026-01-01T00:01:00.000Z",
      }),
    ).toMatchObject({ ok: true });
    await expect(
      plane.triggerScheduleDurable("principal-drain-schedule", "2026-01-01T00:00:30.000Z"),
    ).resolves.toMatchObject({
      ok: false,
      code: "DRAINING",
      operationId: "principal-drain-operation",
    });

    expect((await invoke("POST", "/api/v1/sessions", createBody, principalB.apiKey)).status).toBe(
      201,
    );

    const released = await invoke(
      "POST",
      "/api/v1/repositories/repo-drain/session-drains/principal-drain-operation/release",
      {},
      principalA.apiKey,
    );
    expect(released.status).toBe(200);
    expect(released.json).toMatchObject({ status: "released" });
    expect((await invoke("POST", "/api/v1/sessions", createBody, principalA.apiKey)).status).toBe(
      201,
    );

    const retained = await invoke(
      "GET",
      "/api/v1/repositories/repo-drain/session-drains/principal-drain-operation",
      undefined,
      principalA.apiKey,
    );
    expect(retained.status).toBe(200);
    expect(retained.json).toMatchObject({ status: "succeeded", cancelledCount: 1 });
    expect(
      (
        await invoke(
          "GET",
          "/api/v1/repositories/repo-drain/session-drains/principal-drain-operation",
          undefined,
          principalB.apiKey,
        )
      ).status,
    ).toBe(404);
  });

  it("waits for a cancelled running worktree to release before succeeding", async () => {
    if (!ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putActiveTestRepository(ctx.storage, "repo-drain-running");
    await ctx.storage.putWorktree({
      id: "worktree-drain-running",
      name: "running",
      hostId: "host-drain-running",
      repositoryId: "repo-drain-running",
      path: "/tmp/drain-running",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "session-drain-running",
    });
    await ctx.storage.putSession(
      session("session-drain-running", "repo-drain-running", "principal-running", {
        status: "running",
        worktreeId: "worktree-drain-running",
        hostId: "host-drain-running",
        assignmentConnectionId: "connection-drain-running",
        attemptId: "attempt-drain-running",
      }),
    );
    await ctx.storage.putSession(
      session("session-other-principal", "repo-drain-running", "principal-other"),
    );
    let now = "2026-01-01T00:00:00.000Z";
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      sessionDrainIdFactory: () => "running-drain-operation",
      now: () => now,
      shardCount: 1,
    });

    const started = await plane.createSessionDrainDurable(
      "repo-drain-running",
      "principal-running",
    );
    expect(started).toMatchObject({
      created: true,
      drain: { status: "draining", runningCount: 1, cancelledCount: 1 },
    });
    expect(await ctx.storage.getSession("session-drain-running")).toMatchObject({
      status: "cancelled",
      worktreeId: "worktree-drain-running",
    });
    expect((await ctx.storage.getSession("session-other-principal"))?.status).toBe("queued");

    now = "2026-01-01T00:00:01.000Z";
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:status",
          sessionId: "session-drain-running",
          worktreeId: "worktree-drain-running",
          attemptId: "attempt-drain-running",
          status: "cancelled",
        })
      ).ok,
    ).toBe(true);
    await expect(
      plane.getSessionDrainDurable(
        "repo-drain-running",
        "principal-running",
        "running-drain-operation",
      ),
    ).resolves.toMatchObject({ status: "succeeded", runningCount: 0, cancelledCount: 1 });
  });

  it("blocks assignment for a session queued before the drain fence commits", async () => {
    if (!ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putActiveTestRepository(ctx.storage, "repo-drain-assignment");
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      connectionIdFactory: () => "connection-drain-assignment",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    expect(
      await plane.registerHostDurable({
        hostId: "host-drain-assignment",
        worktrees: [
          {
            id: "worktree-drain-assignment",
            name: "assignment",
            repositoryId: "repo-drain-assignment",
            path: "/tmp/drain-assignment",
            labels: [],
          },
        ],
        commandProfiles: ["drain command"],
        replaceExisting: true,
      }),
    ).toMatchObject({ ok: true });
    await ctx.storage.putSession(
      session("session-drain-assignment", "repo-drain-assignment", "principal-assignment"),
    );
    await ctx.storage.createOrGetSessionDrain({
      scopeKey: "",
      recordKey: "",
      operationId: "assignment-drain-operation",
      repositoryId: "repo-drain-assignment",
      principalId: "principal-assignment",
      status: "draining",
      requestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deadlineAt: "2026-01-01T00:15:00.000Z",
      queuedCount: 1,
      runningCount: 0,
      cancelledCount: 0,
    });
    await plane.hydrateFromStorage();

    await expect(plane.assignQueuedDurable()).resolves.toEqual([]);
    expect((await ctx.storage.getSession("session-drain-assignment"))?.status).toBe("queued");
    expect((await ctx.storage.getWorktree("worktree-drain-assignment"))?.status).toBe("idle");
    await expect(
      plane.getSessionDrainDurable(
        "repo-drain-assignment",
        "principal-assignment",
        "assignment-drain-operation",
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      plane.releaseSessionDrainDurable(
        "repo-drain-assignment",
        "principal-assignment",
        "assignment-drain-operation",
      ),
    ).resolves.toMatchObject({ status: "released" });
  });

  it("replays an idempotency key after release and explicitly releases failed drains", async () => {
    if (!ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await Promise.all([
      putActiveTestRepository(ctx.storage, "repo-drain-idempotent"),
      putActiveTestRepository(ctx.storage, "repo-drain-timeout"),
    ]);
    let now = "2026-01-01T00:00:00.000Z";
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "idempotent-created-session",
      sessionDrainIdFactory: () => "unused-random-operation",
      sessionDrainTimeoutMs: 1,
      now: () => now,
      shardCount: 1,
    });

    const first = await plane.createSessionDrainDurable(
      "repo-drain-idempotent",
      "principal-idempotent",
      "filaments-deployment-42",
    );
    expect(first).toMatchObject({ created: true, drain: { status: "succeeded" } });
    if (!("drain" in first)) throw new Error("expected a created drain");
    expect(
      await plane.releaseSessionDrainDurable(
        "repo-drain-idempotent",
        "principal-idempotent",
        first.drain.operationId,
      ),
    ).toMatchObject({ status: "released" });
    await expect(
      plane.createSessionDrainDurable(
        "repo-drain-idempotent",
        "principal-idempotent",
        "filaments-deployment-42",
      ),
    ).resolves.toMatchObject({
      created: false,
      drain: { operationId: first.drain.operationId, status: "succeeded" },
    });
    await expect(
      plane.createSessionDrainDurable(
        "repo-drain-idempotent",
        "principal-idempotent",
        "invalid key with spaces",
      ),
    ).resolves.toEqual({ error: "invalid Idempotency-Key", code: "VALIDATION_ERROR" });
    await expect(
      plane.createSessionDurable(
        {
          repositoryId: "repo-drain-idempotent",
          prompt: "admission was released",
          target: { commandId: "command-drain" },
          timeout: 30,
        },
        { principalId: "principal-idempotent" },
      ),
    ).resolves.toMatchObject({ ok: true });

    await ctx.storage.putWorktree({
      id: "worktree-drain-timeout",
      name: "timeout",
      hostId: "host-drain-timeout",
      repositoryId: "repo-drain-timeout",
      path: "/tmp/drain-timeout",
      labels: [],
      status: "busy",
      online: false,
      currentSessionId: "session-drain-timeout",
    });
    await ctx.storage.putSession(
      session("session-drain-timeout", "repo-drain-timeout", "principal-timeout", {
        status: "cancelled",
        completedAt: now,
        worktreeId: "worktree-drain-timeout",
        hostId: "host-drain-timeout",
        attemptId: "attempt-drain-timeout",
      }),
    );
    const timingOut = await plane.createSessionDrainDurable(
      "repo-drain-timeout",
      "principal-timeout",
    );
    expect(timingOut).toMatchObject({ drain: { status: "draining" } });
    if (!("drain" in timingOut)) throw new Error("expected a timeout drain");
    now = "2026-01-01T00:00:00.002Z";
    await expect(plane.reconcileSessionDrainsDurable()).resolves.toEqual([
      expect.objectContaining({ status: "failed", failureCode: "DEADLINE_EXCEEDED" }),
    ]);
    await expect(
      plane.releaseSessionDrainDurable(
        "repo-drain-timeout",
        "principal-timeout",
        timingOut.drain.operationId,
      ),
    ).resolves.toMatchObject({ status: "released" });
    expect((await plane.listAuditLogs({ action: "session-drain:failed" })).items).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: "system" }),
        repositoryId: "repo-drain-timeout",
        metadata: expect.objectContaining({ operationId: timingOut.drain.operationId }),
      }),
    ]);
  });

  it("cancels and reconciles an exact scheduled main-checkout lease", async () => {
    if (!ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await putActiveTestRepository(ctx.storage, "repo-drain-main");
    const outbound: unknown[] = [];
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "session-drain-main",
      connectionIdFactory: () => "connection-drain-main",
      sessionDrainIdFactory: () => "operation-drain-main",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onHostMessage: (_hostId, message) => outbound.push(message),
    });
    expect(
      await plane.registerHostDurable({
        hostId: "host-drain-main",
        worktrees: [],
        repositories: [
          { id: "repo-drain-main", path: "/tmp/repo-drain-main", defaultBranch: "main" },
        ],
        capabilities: ["scheduled-main-checkout"],
        replaceExisting: true,
      }),
    ).toMatchObject({ ok: true });
    await expect(
      plane.createSessionDurable(
        {
          repositoryId: "repo-drain-main",
          prompt: "scheduled drain",
          target: { commandId: "command-drain" },
          timeout: 30,
          type: "scheduled",
          source: "schedule",
          concurrencyId: "schedule-drain-main",
        },
        { principalId: "principal-drain-main" },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(await plane.assignScheduledQueuedDurable()).toHaveLength(1);
    const assigned = (await ctx.storage.getSession("session-drain-main"))!;

    await expect(
      plane.createSessionDrainDurable("repo-drain-main", "principal-drain-main"),
    ).resolves.toMatchObject({
      drain: { status: "draining", runningCount: 1, cancelledCount: 1 },
    });
    expect(outbound).toContainEqual({ type: "session:cancel", sessionId: assigned.id });
    await expect(
      plane.handleHostMessageDurable(
        {
          type: "session:status",
          sessionId: assigned.id,
          worktreeId: null,
          attemptId: assigned.attemptId!,
          status: "cancelled",
        },
        assigned.assignmentConnectionId!,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      plane.getSessionDrainDurable(
        "repo-drain-main",
        "principal-drain-main",
        "operation-drain-main",
      ),
    ).resolves.toMatchObject({ status: "succeeded", runningCount: 0 });
  });
});
