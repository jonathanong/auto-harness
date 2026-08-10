/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "./db/types.ts";
import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import { createControlPlane } from "./create-plane.ts";
import { ControlPlane } from "./control-plane.ts";
import { ControlPlaneBase } from "./control-plane-facade.ts";
import { heartbeatDurable } from "./control-plane-agents.ts";
import { enforceAckDeadlinesDurable } from "./control-plane-assign.ts";
import { reclaimStaleHostsDurable } from "./control-plane-lifecycle.ts";
import { appendLogDurable } from "./control-plane-messages.ts";
import { tryClaimScheduleFireDurable } from "./control-plane-schedule-fire.ts";
import { offlineHostAndRequeueDurable } from "./control-plane-worktrees.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Durable");

describe("durable control-plane transitions", () => {
  it("allows only one hydrated control plane to assign a session", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putCommand({
      id: "cmd-durable",
      name: "echo",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const first = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "session-durable",
      connectionIdFactory: () => "connection-durable",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      ackDeadlineMs: 1,
      heartbeatStaleMs: 1,
    });
    const registered = await first.plane.registerHostDurable({
      hostId: "host-durable",
      worktrees: [
        {
          id: "worktree-durable",
          name: "worktree-durable",
          repositoryId: "repo-durable",
          path: "/tmp/worktree-durable",
          labels: [],
        },
      ],
      commandProfiles: ["echo"],
      replaceExisting: true,
    });
    expect(registered.ok).toBe(true);
    const session: SessionRecord = {
      id: "session-durable",
      repositoryId: "repo-durable",
      prompt: "durable assignment",
      target: { commandId: "cmd-durable" },
      fallbacks: [],
      targetLabels: ["echo"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await ctx.storage.putSession(session);
    const second = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await Promise.all([first.plane.hydrateFromStorage(), second.plane.hydrateFromStorage()]);

    const [a, b] = await Promise.all([
      first.plane.assignQueuedDurable(),
      second.plane.assignQueuedDurable(),
    ]);
    expect(a.length + b.length).toBe(1);
    expect((await ctx.storage.getSession(session.id))?.status).toBe("running");
    expect(
      (await ctx.storage.listSessionsByStatus("queued", 0)).some((s) => s.id === session.id),
    ).toBe(false);
    expect(
      (await ctx.storage.listSessionsByStatus("running", 0)).some((s) => s.id === session.id),
    ).toBe(true);
    expect((await ctx.storage.getWorktree("worktree-durable"))?.currentSessionId).toBe(session.id);
  });

  it("persists the native resume snapshot through assignment and hydration", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const commandId = "cmd-resume-snapshot";
    const sessionId = "session-resume-snapshot";
    const resumeSpec = {
      argv: ["codex", "exec"],
      appendPrompt: true,
      resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout" as const, linePrefix: "session id: " },
    };
    await ctx.storage.putCommand({
      id: commandId,
      name: "codex snapshot",
      argv: resumeSpec.argv,
      appendPrompt: resumeSpec.appendPrompt,
      resumeArgvTemplate: resumeSpec.resumeArgvTemplate,
      resumeRefCapture: resumeSpec.resumeRefCapture,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const created = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => sessionId,
      connectionIdFactory: () => "connection-resume-snapshot",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    const registered = await created.plane.registerHostDurable({
      hostId: "host-resume-snapshot",
      worktrees: [
        {
          id: "worktree-resume-snapshot",
          name: "snapshot",
          repositoryId: "repo-resume-snapshot",
          path: "/tmp/worktree-resume-snapshot",
          labels: [],
        },
      ],
      commandProfiles: ["codex snapshot"],
      replaceExisting: true,
    });
    expect(registered.ok).toBe(true);
    await ctx.storage.putSession({
      id: sessionId,
      repositoryId: "repo-resume-snapshot",
      prompt: "first prompt",
      target: { commandId },
      fallbacks: [],
      targetLabels: ["codex snapshot"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await created.plane.hydrateFromStorage();
    expect(await created.plane.assignQueuedDurable()).toHaveLength(1);
    expect((await ctx.storage.getSession(sessionId))?.resumeSpec).toEqual(resumeSpec);

    expect(created.plane.deleteCommand(commandId).ok).toBe(true);
    await created.plane.settleStorage();
    expect(await ctx.storage.getCommand(commandId)).toBeNull();

    const hydrated = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
    });
    expect(hydrated.plane.getCommand(commandId)).toBeNull();
    expect(hydrated.plane.getSession(sessionId)).toMatchObject({
      status: "running",
      resumeSpec,
    });
  });

  it("claims schedule fire once and keeps it out of worktree assignment", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putCommand({
      id: "cmd-schedule",
      name: "echo schedule",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await ctx.storage.putSchedule({
      id: "schedule-durable",
      repositoryId: "repo-schedule",
      name: "nightly",
      target: { commandId: "cmd-schedule" },
      fallbacks: [],
      targetLabels: ["echo schedule"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const opts = {
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: (() => {
        let i = 0;
        return () => `scheduled-${i++}`;
      })(),
      shardCount: 1,
    };
    const first = await createControlPlane(opts);
    const second = await createControlPlane({ ...opts, idFactory: () => "scheduled-other" });
    await Promise.all([first.plane.hydrateFromStorage(), second.plane.hydrateFromStorage()]);
    const [a, b] = await Promise.all([
      first.plane.tryClaimScheduleFireDurable(
        "schedule-durable",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
      second.plane.tryClaimScheduleFireDurable(
        "schedule-durable",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ]);
    expect(Number(a !== null) + Number(b !== null)).toBe(1);
    expect(
      (await ctx.storage.listAllSessions()).filter((s) => s.type === "scheduled"),
    ).toHaveLength(1);

    await ctx.storage.putSchedule({
      id: "schedule-evaluate",
      repositoryId: "repo-schedule",
      name: "evaluate",
      target: { commandId: "cmd-schedule" },
      fallbacks: [],
      targetLabels: ["echo schedule"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await first.plane.hydrateFromStorage();
    expect(await first.plane.evaluateCronDurable("2026-01-01T00:00:00.000Z")).toHaveLength(1);

    const winner = a ? first.plane : second.plane;
    const reg = await winner.registerHostDurable({
      hostId: "host-schedule",
      worktrees: [
        {
          id: "worktree-schedule",
          name: "worktree-schedule",
          repositoryId: "repo-schedule",
          path: "/tmp/worktree-schedule",
          labels: [],
        },
      ],
      commandProfiles: ["echo schedule"],
      capabilities: ["scheduled-main-checkout"],
      replaceExisting: true,
    });
    expect(reg.ok).toBe(true);
    await winner.hydrateFromStorage();
    const assigned = await winner.assignQueuedDurable();
    expect(assigned).toEqual([]);
    const scheduled = (await ctx.storage.listAllSessions()).find(
      (session) => session.type === "scheduled" && session.repositoryId === "repo-schedule",
    );
    expect(scheduled?.status).toBe("queued");
    expect((await ctx.storage.getWorktree("worktree-schedule"))?.status).toBe("idle");
    expect((await winner.disconnectHostDurable(reg.ok ? reg.connectionId : "missing")).length).toBe(
      0,
    );
    expect((await ctx.storage.getSession(scheduled!.id))?.status).toBe("queued");
    expect((await ctx.storage.getWorktree("worktree-schedule"))?.online).toBe(false);
  });

  it("allows exactly one durable manual trigger before a schedule is due", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putCommand({
      id: "cmd-manual-durable",
      name: "manual durable",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await ctx.storage.putSchedule({
      id: "schedule-manual-durable",
      repositoryId: "repo-manual-durable",
      name: "manual",
      target: { commandId: "cmd-manual-durable" },
      fallbacks: [],
      targetLabels: ["manual durable"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      nextRunAt: "2030-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const first = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "manual-durable-first",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    const second = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "manual-durable-second",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await Promise.all([first.plane.hydrateFromStorage(), second.plane.hydrateFromStorage()]);
    const [a, b] = await Promise.all([
      first.plane.triggerScheduleDurable("schedule-manual-durable"),
      second.plane.triggerScheduleDurable("schedule-manual-durable"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(Number(a.ok && a.created) + Number(b.ok && b.created)).toBe(1);
    expect(
      (await ctx.storage.listAllSessions()).filter((s) => s.repositoryId === "repo-manual-durable"),
    ).toHaveLength(1);
    expect((await ctx.storage.getSchedule("schedule-manual-durable"))?.nextRunAt).toBe(
      "2026-01-01T00:01:00.000Z",
    );
  });

  it("does not let a stale connection disconnect a replacement lease", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const oldCreated = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      connectionIdFactory: () => "connection-old",
    });
    const old = await oldCreated.plane.registerHostDurable({
      hostId: "host-replacement",
      worktrees: [],
      commandProfiles: [],
      replaceExisting: true,
    });
    expect(old.ok).toBe(true);
    const replacementCreated = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      connectionIdFactory: () => "connection-new",
    });
    await replacementCreated.plane.hydrateFromStorage();
    // Simulate a separate API process that has not cached the old connection.
    replacementCreated.plane.state.connections.clear();
    replacementCreated.plane.state.hostConnection.clear();
    const replacement = await replacementCreated.plane.registerHostDurable({
      hostId: "host-replacement",
      worktrees: [],
      commandProfiles: [],
      replaceExisting: true,
    });
    expect(replacement.ok).toBe(true);
    expect(await oldCreated.plane.disconnectHostDurable("connection-old")).toEqual([]);
    expect(await ctx.storage.getHostLock("host-replacement")).toBe("connection-new");
    expect(await ctx.storage.getConnection("connection-old")).toBeNull();
    expect(await ctx.storage.getConnection("connection-new")).not.toBeNull();
  });

  it("does not assign from a stale scheduler after its host lease is released", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putCommand({
      id: "cmd-lease-guard",
      name: "lease guard",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const owner = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => "connection-lease-guard",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    expect(
      (
        await owner.registerHostDurable({
          hostId: "host-lease-guard",
          worktrees: [
            {
              id: "worktree-lease-guard",
              name: "worktree-lease-guard",
              repositoryId: "repo-lease-guard",
              path: "/tmp/lease-guard",
              labels: [],
            },
          ],
          commandProfiles: ["lease guard"],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    await ctx.storage.putSession({
      id: "session-lease-guard",
      repositoryId: "repo-lease-guard",
      prompt: "lease guard",
      target: { commandId: "cmd-lease-guard" },
      fallbacks: [],
      targetLabels: ["lease guard"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const scheduler = new ControlPlane({
      storage: ctx.storage,
      shardCount: 1,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    await scheduler.hydrateFromStorage();
    expect(
      await ctx.storage.releaseHostConnection("host-lease-guard", "connection-lease-guard"),
    ).toBe(true);

    expect(await scheduler.assignQueuedDurable()).toEqual([]);
    expect((await ctx.storage.getSession("session-lease-guard"))?.status).toBe("queued");
    expect((await ctx.storage.getWorktree("worktree-lease-guard"))?.currentSessionId).toBeNull();
  });

  it("releases a cancelled session's worktree when its late terminal report arrives", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putWorktree({
      id: "worktree-cancelled-late-terminal",
      name: "worktree-cancelled-late-terminal",
      hostId: "host-cancelled-late-terminal",
      repositoryId: "repo-cancelled-late-terminal",
      path: "/tmp/cancelled-late-terminal",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "session-cancelled-late-terminal",
    });
    await ctx.storage.putSession({
      id: "session-cancelled-late-terminal",
      repositoryId: "repo-cancelled-late-terminal",
      prompt: "cancelled",
      target: { commandId: "cmd-idempotent" },
      fallbacks: [],
      targetLabels: ["cancelled"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "cancelled",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      worktreeId: "worktree-cancelled-late-terminal",
      hostId: "host-cancelled-late-terminal",
      attemptId: "attempt-cancelled-late-terminal",
    });
    const plane = new ControlPlane({ storage: ctx.storage });
    await plane.hydrateFromStorage();

    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:status",
          sessionId: "session-cancelled-late-terminal",
          worktreeId: "worktree-cancelled-late-terminal",
          attemptId: "attempt-cancelled-late-terminal",
          status: "cancelled",
          cliResumeRef: "cancelled-native-ref",
        })
      ).ok,
    ).toBe(true);
    expect((await ctx.storage.getWorktree("worktree-cancelled-late-terminal"))?.status).toBe(
      "idle",
    );
    expect((await ctx.storage.getWorktree("worktree-cancelled-late-terminal"))?.online).toBe(true);
    const terminal = await ctx.storage.getSession("session-cancelled-late-terminal");
    expect(terminal?.status).toBe("cancelled");
    expect(terminal?.worktreeId).toBeNull();
    expect(terminal?.hostId).toBe("host-cancelled-late-terminal");
    expect(terminal?.cliResumeRef).toBe("cancelled-native-ref");
    expect(plane.resumeSession("session-cancelled-late-terminal").ok).toBe(true);
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:status",
          sessionId: "session-cancelled-late-terminal",
          worktreeId: "worktree-cancelled-late-terminal",
          attemptId: "attempt-cancelled-late-terminal",
          status: "completed",
        })
      ).ok,
    ).toBe(true);
  });

  it("durably restores earlier reconnect confirmations when a later grace sweep wins", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const hostId = "host-reconnect-rollback";
    const deadline = "2026-01-01T00:01:15.000Z";
    const oldConnection = "connection-reconnect-old";
    for (const suffix of ["first", "second"] as const) {
      const sessionId = `session-reconnect-${suffix}`;
      const worktreeId = `worktree-reconnect-${suffix}`;
      await ctx.storage.putWorktree({
        id: worktreeId,
        name: worktreeId,
        hostId,
        repositoryId: "repo-reconnect-rollback",
        path: `/tmp/${worktreeId}`,
        labels: [],
        status: "busy",
        online: false,
        currentSessionId: sessionId,
        connectionId: oldConnection,
      });
      await ctx.storage.putSession({
        id: sessionId,
        repositoryId: "repo-reconnect-rollback",
        prompt: suffix,
        target: { commandId: "cmd-reconnect-rollback" },
        fallbacks: [],
        targetLabels: ["reconnect rollback"],
        queueTtlSeconds: 691200,
        queueExpiresAt: "2026-01-09T00:00:00.000Z",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        onConflict: "queue",
        status: "running",
        queueShard: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        hostId,
        worktreeId,
        attemptId: `attempt-reconnect-${suffix}`,
        ackReceivedAt: "2026-01-01T00:00:01.000Z",
        reconnectDeadlineAt: deadline,
        assignmentConnectionId: oldConnection,
      });
    }
    const originalConfirm = ctx.storage.confirmReconnect.bind(ctx.storage);
    ctx.storage.confirmReconnect = async (opts) => {
      if (opts.sessionId === "session-reconnect-second") {
        // Deterministically model the reclaim transaction winning after the
        // first report was confirmed but before this one is confirmed.
        await ctx.storage!.tryRequeueSession({
          sessionId: "session-reconnect-second",
          worktreeId: "worktree-reconnect-second",
          attemptId: "attempt-reconnect-second",
          queueShard: 0,
          reason: "grace sweep won",
          forceOffline: true,
          expectedHostId: hostId,
          expectedReconnectDeadlineAt: deadline,
          expectedConnectionId: oldConnection,
          fence: { hostId, connectionId: opts.connectionId },
        });
      }
      return originalConfirm(opts);
    };
    try {
      const plane = new ControlPlane({
        storage: ctx.storage,
        connectionIdFactory: () => "connection-reconnect-new",
      });
      await plane.hydrateFromStorage();
      await expect(
        plane.registerHostDurable({
          hostId,
          worktrees: [
            {
              id: "worktree-reconnect-first",
              name: "worktree-reconnect-first",
              repositoryId: "repo-reconnect-rollback",
              path: "/tmp/worktree-reconnect-first",
              labels: [],
            },
            {
              id: "worktree-reconnect-second",
              name: "worktree-reconnect-second",
              repositoryId: "repo-reconnect-rollback",
              path: "/tmp/worktree-reconnect-second",
              labels: [],
            },
          ],
          commandProfiles: [],
          runningSessions: ["session-reconnect-first", "session-reconnect-second"],
        }),
      ).resolves.toMatchObject({ ok: false });

      const first = await ctx.storage.getSession("session-reconnect-first");
      const firstWorktree = await ctx.storage.getWorktree("worktree-reconnect-first");
      expect(first).toMatchObject({
        status: "running",
        reconnectDeadlineAt: deadline,
        assignmentConnectionId: oldConnection,
      });
      expect(firstWorktree).toMatchObject({
        status: "busy",
        online: false,
        connectionId: oldConnection,
      });
      expect((await ctx.storage.getSession("session-reconnect-second"))?.status).toBe("queued");
      expect((await ctx.storage.getWorktree("worktree-reconnect-second"))?.online).toBe(false);
      expect(await ctx.storage.getHostLock(hostId)).toBeNull();
    } finally {
      ctx.storage.confirmReconnect = originalConfirm;
    }
  });

  it("makes duplicate acknowledgements and terminal reports idempotent", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putCommand({
      id: "cmd-idempotent",
      name: "idempotent",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await ctx.storage.putWorktree({
      id: "worktree-idempotent",
      name: "worktree-idempotent",
      hostId: "host-idempotent",
      repositoryId: "repo-idempotent",
      path: "/tmp/idempotent",
      labels: [],
      status: "idle",
      online: true,
    });
    await ctx.storage.putSession({
      id: "session-idempotent",
      repositoryId: "repo-idempotent",
      prompt: "idempotent",
      target: { commandId: "cmd-idempotent" },
      fallbacks: [],
      targetLabels: ["idempotent"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const planeCreated = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "unused",
      connectionIdFactory: () => "connection-idempotent",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      ackDeadlineMs: 1,
      heartbeatStaleMs: 1,
    });
    await planeCreated.plane.hydrateFromStorage();
    expect(
      (
        await planeCreated.plane.registerHostDurable({
          hostId: "host-idempotent",
          worktrees: [
            {
              id: "worktree-idempotent",
              name: "worktree-idempotent",
              repositoryId: "repo-idempotent",
              path: "/tmp/idempotent",
              labels: [],
            },
          ],
          commandProfiles: ["idempotent"],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    await planeCreated.plane.hydrateFromStorage();
    expect(
      (
        await planeCreated.plane.handleHostMessageDurable({
          type: "host:keepalive",
          hostId: "host-idempotent",
          at: "2026-01-01T00:00:01.000Z",
        })
      ).ok,
    ).toBe(true);
    const idempotentAssigned = await planeCreated.plane.assignQueuedDurable();
    expect(idempotentAssigned).toHaveLength(1);
    expect(
      await planeCreated.plane.enforceAckDeadlinesDurable(
        Date.parse("2026-01-01T00:00:01.000Z") + 10_000,
      ),
    ).toEqual(["session-idempotent"]);
    const reassigned = await planeCreated.plane.assignQueuedDurable();
    expect(reassigned).toHaveLength(1);
    const reassignedAttempt = reassigned[0]!.session;
    expect(
      (
        await planeCreated.plane.handleHostMessageDurable({
          type: "session:ack",
          sessionId: "session-idempotent",
          worktreeId: reassignedAttempt.worktreeId!,
          attemptId: reassignedAttempt.attemptId!,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await planeCreated.plane.handleHostMessageDurable({
          type: "session:ack",
          sessionId: "session-idempotent",
          worktreeId: reassignedAttempt.worktreeId!,
          attemptId: reassignedAttempt.attemptId!,
        })
      ).ok,
    ).toBe(true);
    const terminal = {
      type: "session:status" as const,
      sessionId: "session-idempotent",
      worktreeId: reassignedAttempt.worktreeId!,
      attemptId: reassignedAttempt.attemptId!,
      status: "completed" as const,
    };
    expect((await planeCreated.plane.handleHostMessageDurable(terminal)).ok).toBe(true);
    expect((await planeCreated.plane.handleHostMessageDurable(terminal)).ok).toBe(true);
    expect((await ctx.storage.getSession("session-idempotent"))?.status).toBe("completed");
    expect(
      (await ctx.storage.listSessionsByStatus("running", 0)).some(
        (s) => s.id === "session-idempotent",
      ),
    ).toBe(false);
    expect(
      (await ctx.storage.listSessionsByStatus("completed", 0)).some(
        (s) => s.id === "session-idempotent",
      ),
    ).toBe(true);
    expect((await ctx.storage.getWorktree("worktree-idempotent"))?.status).toBe("idle");

    await ctx.storage.putSession({
      id: "session-stale",
      repositoryId: "repo-idempotent",
      prompt: "stale",
      target: { commandId: "cmd-idempotent" },
      fallbacks: [],
      targetLabels: ["idempotent"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const staleHost = `host-stale-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    expect(await ctx.storage.getHostLock(staleHost)).toBeNull();
    const stalePlane = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => "connection-stale",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      heartbeatStaleMs: 1,
    });
    const staleReg = await stalePlane.registerHostDurable({
      hostId: staleHost,
      worktrees: [
        {
          id: "worktree-stale",
          name: "worktree-stale",
          repositoryId: "repo-idempotent",
          path: "/tmp/stale",
          labels: [],
        },
      ],
      commandProfiles: ["idempotent"],
      replaceExisting: true,
    });
    expect(staleReg).toEqual({ ok: true, connectionId: expect.any(String) });
    await stalePlane.hydrateFromStorage();
    expect(await stalePlane.assignQueuedDurable()).toHaveLength(1);
    expect(
      await stalePlane.reclaimStaleHostsDurable(Date.parse("2026-01-01T00:00:00.000Z") + 2),
    ).toEqual(expect.arrayContaining(["session-stale"]));
  });

  it("leaves cache unchanged when post-transaction persistence fails", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const failing = Object.create(ctx.storage) as DynamoPlaneStorage;
    failing.putWorktreeFenced = async () => {
      throw new Error("worktree write failed");
    };
    const planeCreated = new ControlPlane({
      storage: failing,
      connectionIdFactory: () => "connection-failing-write",
    });
    await expect(
      planeCreated.registerHostDurable({
        hostId: "host-failing-write",
        worktrees: [
          {
            id: "worktree-failing-write",
            name: "worktree-failing-write",
            repositoryId: "repo-failing-write",
            path: "/tmp/failing-write",
            labels: [],
          },
        ],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).rejects.toThrow("worktree write failed");
    expect(planeCreated.state.connections.size).toBe(0);
    expect(planeCreated.getWorktree("worktree-failing-write")).toBeNull();
    expect(await ctx.storage.getHostLock("host-failing-write")).toBeNull();
    expect(await ctx.storage.getConnection("connection-failing-write")).toBeNull();

    const logFailing = Object.create(ctx.storage) as DynamoPlaneStorage;
    logFailing.putLog = async () => {
      throw new Error("log write failed");
    };
    await ctx.storage.putSession({
      id: "session-failing-log",
      repositoryId: "repo-failing-log",
      prompt: "log",
      target: { commandId: "cmd-idempotent" },
      fallbacks: [],
      targetLabels: ["log"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const logCreated = new ControlPlane({
      storage: logFailing,
    });
    await logCreated.hydrateFromStorage();
    await expect(
      logCreated.handleHostMessageDurable({
        type: "session:log",
        sessionId: "session-failing-log",
        stream: "stdout",
        content: "should not cache",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      }),
    ).rejects.toThrow("log write failed");
    expect(logCreated.getLogs("session-failing-log")).toEqual([]);
  });

  it("keeps additive durable APIs compatible with storage-less local CAS", async () => {
    const plane = new ControlPlane({
      idFactory: () => "local-durable-session",
      connectionIdFactory: () => "local-durable-connection",
      scheduleIdFactory: () => "local-durable-schedule",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      ackDeadlineMs: 1,
    });
    plane.createCommand({
      id: "local-durable-command",
      name: "echo",
      argv: ["echo"],
      providerId: null,
    });
    const registered = await plane.registerHostDurable({
      hostId: "local-durable-host",
      worktrees: [
        {
          id: "local-durable-worktree",
          name: "local-durable-worktree",
          repositoryId: "local-durable-repo",
          path: "/tmp/local-durable",
          labels: [],
        },
      ],
      commandProfiles: ["echo"],
    });
    expect(registered.ok).toBe(true);
    const created = plane.createSession({
      repositoryId: "local-durable-repo",
      prompt: "local",
      target: { commandId: "local-durable-command" },
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    expect(await plane.assignQueuedDurable()).toHaveLength(1);
    expect(await plane.enforceAckDeadlinesDurable(Date.parse("2026-01-01T00:00:01.000Z"))).toEqual([
      "local-durable-session",
    ]);
    await plane.putSchedule({
      repositoryId: "local-durable-repo",
      name: "local",
      target: { commandId: "local-durable-command" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await plane.evaluateCronDurable("2026-01-01T00:01:00.000Z")).toHaveLength(1);
    expect((await plane.triggerScheduleDurable("local-durable-schedule")).ok).toBe(true);
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:keepalive",
          hostId: "local-durable-host",
        })
      ).ok,
    ).toBe(true);
    await appendLogDurable(plane.state, {
      sessionId: "local-durable-session",
      stream: "system",
      content: "local durable log",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    expect(await plane.reclaimStaleHostsDurable(Date.parse("2026-01-01T00:00:01.000Z"))).toEqual(
      [],
    );
    expect(
      await plane.disconnectHostDurable(registered.ok ? registered.connectionId : "missing"),
    ).toEqual([]);
    expect(await new ControlPlaneBase().reclaimStaleHostsDurable()).toEqual([]);
    expect(new ControlPlaneBase().listSessionsPage().items).toEqual([]);
  });

  it("persists scheduler deadlines, drain ownership, and scheduled target validation", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putCommand({
      id: "cmd-review-durable",
      name: "review durable",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const owner = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => "connection-review-durable",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    expect(
      (
        await owner.registerHostDurable({
          hostId: "host-review-durable",
          worktrees: [
            {
              id: "worktree-review-durable",
              name: "worktree-review-durable",
              repositoryId: "repo-review-durable",
              path: "/tmp/review-durable",
              labels: [],
            },
          ],
          commandProfiles: ["review durable"],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    await ctx.storage.putSession({
      id: "session-review-expired-pin",
      repositoryId: "repo-review-durable",
      prompt: "expired",
      target: { commandId: "cmd-review-durable" },
      fallbacks: [],
      targetLabels: ["review durable"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 1,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      pinnedHostId: "host-review-durable",
      pinExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await ctx.storage.putSession({
      id: "session-review-drain",
      repositoryId: "repo-review-durable",
      prompt: "must not assign after drain",
      target: { commandId: "cmd-review-durable" },
      fallbacks: [],
      targetLabels: ["review durable"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const staleScheduler = new ControlPlane({
      storage: ctx.storage,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await staleScheduler.hydrateFromStorage();
    // A later resume can extend the deadline. The stale scheduler must not
    // overwrite that newer pin while failing the genuinely expired session.
    await ctx.storage.putSession({
      id: "session-review-refreshed-pin",
      repositoryId: "repo-review-durable",
      prompt: "refreshed",
      target: { commandId: "cmd-review-durable" },
      fallbacks: [],
      targetLabels: ["review durable"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      pinnedHostId: "host-review-durable",
      pinExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    staleScheduler.state.sessions.set("session-review-refreshed-pin", {
      ...(await ctx.storage.getSession("session-review-refreshed-pin"))!,
      pinExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await ctx.storage.putSession({
      ...(await ctx.storage.getSession("session-review-refreshed-pin"))!,
      pinExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    // This process deliberately has no local socket owner; it must resolve
    // the durable lease before persisting the drain flag.
    const freshDrainer = new ControlPlane({ storage: ctx.storage });
    await freshDrainer.hydrateFromStorage();
    freshDrainer.state.hostConnection.clear();
    expect((await freshDrainer.drainHostDurable("host-review-durable")).ok).toBe(true);
    const losingStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    losingStorage.markHostDraining = async () => false;
    const losingDrainer = new ControlPlane({ storage: losingStorage });
    losingDrainer.state.hostConnection.set("host-review-lost-lease", "connection-lost-lease");
    expect(await losingDrainer.drainHostDurable("host-review-lost-lease")).toEqual({
      ok: false,
      runningSessionIds: [],
    });
    const assigned = await staleScheduler.assignQueuedDurable();
    expect(assigned.some((item) => item.session.id === "session-review-drain")).toBe(false);
    const expired = await ctx.storage.getSession("session-review-expired-pin");
    expect(expired?.status).toBe("queued");
    expect(expired?.resumeFallback).toBe(true);
    expect(expired?.pinnedHostId).toBeUndefined();
    expect((await ctx.storage.getSession("session-review-refreshed-pin"))?.status).toBe("queued");
    expect((await ctx.storage.getSession("session-review-refreshed-pin"))?.pinExpiresAt).toBe(
      "2099-01-01T00:00:00.000Z",
    );
    expect((await ctx.storage.getSession("session-review-drain"))?.status).toBe("queued");
    expect((await ctx.storage.getWorktree("worktree-review-durable"))?.online).toBe(false);

    await ctx.storage.putSchedule({
      id: "schedule-review-missing-target",
      repositoryId: "repo-review-target",
      name: "missing target",
      target: { commandId: "cmd-review-durable" },
      fallbacks: [],
      targetLabels: ["review durable"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const schedulePlane = new ControlPlane({
      storage: ctx.storage,
      idFactory: () => "session-review-missing-target",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await schedulePlane.hydrateFromStorage();
    await ctx.storage.deleteCommand("cmd-review-durable");
    schedulePlane.state.commands.delete("cmd-review-durable");
    expect(await schedulePlane.triggerScheduleDurable("schedule-review-missing-target")).toEqual({
      ok: false,
      error: "commandId cmd-review-durable not found",
    });
    expect(
      await schedulePlane.tryClaimScheduleFireDurable(
        "schedule-review-missing-target",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBeNull();
    expect((await ctx.storage.getSchedule("schedule-review-missing-target"))?.nextRunAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(await ctx.storage.getSession("session-review-missing-target")).toBeNull();

    await ctx.storage.putProvider({ id: "provider-review-missing", name: "review provider" });
    await ctx.storage.putProviderAccount({
      id: "account-review-missing",
      providerId: "provider-review-missing",
      label: "review account",
    });
    await ctx.storage.putSchedule({
      id: "schedule-review-missing-account",
      repositoryId: "repo-review-account",
      name: "missing account",
      target: { providerId: "provider-review-missing" },
      fallbacks: [],
      targetLabels: ["review provider"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const providerSchedulePlane = new ControlPlane({
      storage: ctx.storage,
      idFactory: () => "session-review-missing-account",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await providerSchedulePlane.hydrateFromStorage();
    await ctx.storage.deleteProviderAccount("account-review-missing");
    providerSchedulePlane.state.providerAccounts.delete("account-review-missing");
    const queuedWithoutCapacity = await providerSchedulePlane.tryClaimScheduleFireDurable(
      "schedule-review-missing-account",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    expect(queuedWithoutCapacity?.status).toBe("queued");
    expect((await ctx.storage.getSchedule("schedule-review-missing-account"))?.nextRunAt).toBe(
      "2026-01-01T00:01:00.000Z",
    );
    expect((await ctx.storage.getSession("session-review-missing-account"))?.status).toBe("queued");
  });

  it("covers durable guard branches and optional transition fields", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    let connectionNumber = 0;
    const plane = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => `coverage-connection-${++connectionNumber}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      ackDeadlineMs: 1,
      heartbeatStaleMs: 1,
    });
    await plane.hydrateFromStorage();
    const registered = await plane.registerHostDurable({
      hostId: "coverage-host",
      worktrees: [
        {
          id: "coverage-worktree",
          name: "coverage-worktree",
          repositoryId: "coverage-repo",
          path: "/tmp/coverage",
          labels: [],
        },
      ],
      commandProfiles: [],
      replaceExisting: true,
    });
    expect(registered.ok).toBe(true);
    expect(
      (
        await plane.registerHostDurable({
          hostId: "coverage-host",
          worktrees: [
            {
              id: "bad",
              name: "not valid",
              repositoryId: "coverage-repo",
              path: "/tmp",
              labels: [],
            },
          ],
          commandProfiles: [],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:register",
          hostId: "coverage-message-host",
          worktrees: [],
          commandProfiles: [],
        })
      ).ok,
    ).toBe(true);
    expect(await plane.disconnectHostDurable("missing-coverage-connection")).toEqual([]);
    expect(
      (
        await plane.registerHostDurable({
          hostId: "coverage-host",
          worktrees: [],
          commandProfiles: [],
        })
      ).ok,
    ).toBe(false);

    const loser = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => "coverage-loser",
    });
    expect(
      (
        await loser.registerHostDurable({
          hostId: "coverage-host",
          worktrees: [],
          commandProfiles: [],
        })
      ).ok,
    ).toBe(false);

    const worktree = plane.state.worktrees.get("coverage-worktree")!;
    worktree.status = "busy";
    worktree.currentSessionId = "coverage-existing";
    const replaced = await plane.registerHostDurable({
      hostId: "coverage-host",
      worktrees: [
        {
          id: "coverage-worktree",
          name: "coverage-worktree",
          repositoryId: "coverage-repo",
          path: "/tmp/coverage",
          labels: [],
        },
      ],
      commandProfiles: [],
      replaceExisting: true,
    });
    expect(replaced.ok).toBe(true);
    expect(
      (
        await plane.registerHostDurable({
          hostId: "coverage-host",
          worktrees: [],
          commandProfiles: [],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    plane.state.worktrees.set("coverage-worktree", {
      ...plane.state.worktrees.get("coverage-worktree")!,
      status: "idle",
      currentSessionId: null,
      online: true,
    });
    await ctx.storage.putWorktree(plane.state.worktrees.get("coverage-worktree")!);

    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:keepalive",
          hostId: "missing-coverage-host",
        })
      ).ok,
    ).toBe(false);
    const failingHeartbeat = Object.create(ctx.storage) as DynamoPlaneStorage;
    failingHeartbeat.heartbeatConnection = async () => false;
    const heartbeatPlane = new ControlPlane({ storage: failingHeartbeat });
    heartbeatPlane.state.hostConnection.set("coverage-host", "coverage-connection-3");
    heartbeatPlane.state.connections.set("coverage-connection-3", {
      connectionId: "coverage-connection-3",
      type: "host",
      hostId: "coverage-host",
      connectedAt: "t",
      lastHeartbeatAt: "t",
      commandProfiles: [],
    });
    expect(
      (
        await heartbeatPlane.handleHostMessageDurable({
          type: "host:keepalive",
          hostId: "coverage-host",
        })
      ).ok,
    ).toBe(false);

    await ctx.storage.putCommand({
      id: "coverage-command",
      name: "coverage",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    plane.state.commands.set("coverage-command", {
      id: "coverage-command",
      name: "coverage",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    const optionsSession: SessionRecord = {
      id: "coverage-options-session",
      repositoryId: "coverage-repo",
      prompt: "coverage",
      target: { commandId: "coverage-command" },
      fallbacks: [],
      targetLabels: ["coverage"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t",
      ref: "main",
      metadata: { source: "coverage" },
      resumedFromSessionId: "coverage-source",
      cliResumeRef: "coverage-ref",
    };
    await ctx.storage.putSession(optionsSession);
    plane.state.sessions.set(optionsSession.id, optionsSession);
    plane.state.onHostMessage = () => undefined;
    const coverageAssigned = await plane.assignQueuedDurable();
    expect(coverageAssigned.some((item) => item.session.id === optionsSession.id)).toBe(true);
    const coverageAttempt = coverageAssigned.find(
      (item) => item.session.id === optionsSession.id,
    )!.session;
    expect(await plane.enforceAckDeadlinesDurable(Date.parse("2026-01-01T00:00:00.000Z"))).toEqual(
      [],
    );
    const expired = {
      ...optionsSession,
      id: "coverage-expired",
      queueExpiresAt: "2000-01-01T00:00:00.000Z",
    };
    const acknowledged = {
      ...optionsSession,
      id: "coverage-acknowledged",
      hostId: "coverage-host",
      worktreeId: "coverage-worktree",
      ackReceivedAt: "t",
    };
    const pinned = {
      ...optionsSession,
      id: "coverage-pinned",
      pinnedHostId: "other-host",
      pinExpiresAt: "2000-01-01T00:00:00.000Z",
    };
    const missingCommand = {
      ...optionsSession,
      id: "coverage-missing-command",
      target: { commandId: "missing" },
    };
    plane.state.sessions.set(expired.id, expired);
    plane.state.sessions.set(acknowledged.id, acknowledged);
    plane.state.sessions.set(pinned.id, pinned);
    plane.state.sessions.set(missingCommand.id, missingCommand);
    await plane.assignQueuedDurable();

    const retryStatus = {
      type: "session:status" as const,
      sessionId: optionsSession.id,
      worktreeId: coverageAttempt.worktreeId!,
      attemptId: coverageAttempt.attemptId!,
      status: "failed" as const,
      errorCode: "usage_limit",
      errorMessage: "quota",
      exitCode: 1,
      cliResumeRef: "new-ref",
    };
    expect((await plane.handleHostMessageDurable(retryStatus)).ok).toBe(true);
    expect((await plane.handleHostMessageDurable({ ...retryStatus, status: "running" })).ok).toBe(
      true,
    );
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:ack",
          sessionId: "missing",
          worktreeId: "missing-worktree",
          attemptId: "missing-attempt",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:log",
          sessionId: optionsSession.id,
          stream: "stdout",
          content: "coverage",
          timestamp: "2026-01-01T00:00:00.000Z",
          seq: 1,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:status",
          sessionId: "missing-status",
          worktreeId: "missing-worktree",
          attemptId: "missing-attempt",
          status: "completed",
        })
      ).ok,
    ).toBe(false);
    expect((await plane.handleHostMessageDurable({ type: "unsupported" } as never)).ok).toBe(false);

    const noWorktree: SessionRecord = {
      ...optionsSession,
      id: "coverage-no-worktree",
      status: "running",
      worktreeId: null,
      hostId: null,
    };
    await ctx.storage.putSession(noWorktree);
    plane.state.sessions.set(noWorktree.id, noWorktree);
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "session:status",
          sessionId: noWorktree.id,
          worktreeId: "missing-worktree",
          attemptId: "missing-attempt",
          status: "completed",
        })
      ).ok,
    ).toBe(true);

    const failedFinish = Object.create(ctx.storage) as DynamoPlaneStorage;
    failedFinish.finishSession = async () => false;
    const failedFinishPlane = new ControlPlane({ storage: failedFinish });
    failedFinishPlane.state.sessions.set(noWorktree.id, noWorktree);
    expect(
      (
        await failedFinishPlane.handleHostMessageDurable({
          type: "session:status",
          sessionId: noWorktree.id,
          worktreeId: "missing-worktree",
          attemptId: "missing-attempt",
          status: "completed",
        })
      ).ok,
    ).toBe(true);

    plane.state.schedules.set("coverage-disabled", {
      id: "coverage-disabled",
      repositoryId: "coverage-repo",
      name: "disabled",
      target: { commandId: "coverage-command" },
      fallbacks: [],
      targetLabels: ["coverage"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: false,
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "t",
    });
    plane.state.schedules.set("coverage-future", {
      ...plane.state.schedules.get("coverage-disabled")!,
      id: "coverage-future",
      enabled: true,
      nextRunAt: "2027-01-01T00:00:00.000Z",
    });
    expect((await plane.triggerScheduleDurable("missing-coverage-schedule")).ok).toBe(false);
    expect((await plane.triggerScheduleDurable("coverage-disabled")).ok).toBe(false);
    expect(
      await plane.tryClaimScheduleFireDurable(
        "coverage-disabled",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBeNull();
    expect(
      await plane.tryClaimScheduleFireDurable(
        "coverage-future",
        "2027-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("covers durable fallback, stale ownership, and conditional-loss branches", async () => {
    const local = new ControlPlane({
      connectionIdFactory: () => "coverage-local-connection",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(
      local.registerHost({ hostId: "coverage-local-host", worktrees: [], commandProfiles: [] }).ok,
    ).toBe(true);
    expect(await heartbeatDurable(local.state, "coverage-local-host")).toBe(true);
    expect(
      await offlineHostAndRequeueDurable(local.state, "coverage-local-host", "offline"),
    ).toEqual([]);

    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }

    const stale = new ControlPlane({ storage: ctx.storage, heartbeatStaleMs: 1 });
    stale.state.disconnectedHosts.set("coverage-disconnected", {
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    expect(
      await reclaimStaleHostsDurable(stale.state, Date.parse("2026-01-01T00:00:00.000Z")),
    ).toEqual([]);

    const releaseLostStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    releaseLostStorage.releaseHostConnection = async () => false;
    const releaseLost = new ControlPlane({ storage: releaseLostStorage, heartbeatStaleMs: 1 });
    releaseLost.state.hostConnection.set("coverage-release-lost", "coverage-release-connection");
    releaseLost.state.connections.set("coverage-release-connection", {
      connectionId: "coverage-release-connection",
      type: "host",
      hostId: "coverage-release-lost",
      connectedAt: "2000-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
      commandProfiles: [],
    });
    expect(
      await reclaimStaleHostsDurable(releaseLost.state, Date.parse("2026-01-01T00:00:00.000Z")),
    ).toEqual([]);

    const requeueLostStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    requeueLostStorage.tryRequeueSession = async () => false;
    requeueLostStorage.getWorktree = async () => null;
    requeueLostStorage.getSession = async () => null;
    const requeueLost = new ControlPlane({ storage: requeueLostStorage, ackDeadlineMs: 1 });
    requeueLost.state.sessions.set("coverage-requeue-lost", {
      id: "coverage-requeue-lost",
      repositoryId: "coverage-repo",
      prompt: "requeue",
      target: { commandId: "coverage-command" },
      fallbacks: [],
      targetLabels: ["coverage"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2000-01-01T00:00:00.000Z",
      hostId: "coverage-requeue-host",
      worktreeId: "coverage-requeue-worktree",
    });
    requeueLost.state.pendingAcks.set("coverage-requeue-lost", {
      sessionId: "coverage-requeue-lost",
      worktreeId: "coverage-requeue-worktree",
      assignedAtMs: 0,
    });
    expect(
      await enforceAckDeadlinesDurable(requeueLost.state, Date.parse("2026-01-01T00:00:00.000Z")),
    ).toEqual([]);

    const idleStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    idleStorage.setWorktreeOnline = async () => undefined;
    idleStorage.setWorktreeOnlineFenced = async () => true;
    const idle = new ControlPlane({ storage: idleStorage });
    idle.state.worktrees.set("coverage-idle-worktree", {
      id: "coverage-idle-worktree",
      name: "coverage-idle-worktree",
      hostId: "coverage-idle-host",
      repositoryId: "coverage-repo",
      path: "/tmp/coverage-idle",
      labels: [],
      status: "idle",
      online: true,
      currentSessionId: null,
      connectionId: "coverage-idle-connection",
    });
    await ctx.storage.putWorktree(idle.state.worktrees.get("coverage-idle-worktree")!);
    expect(
      await offlineHostAndRequeueDurable(
        idle.state,
        "coverage-idle-host",
        "coverage-idle-connection",
        "offline",
      ),
    ).toEqual([]);
    expect(idle.state.worktrees.get("coverage-idle-worktree")?.online).toBe(false);

    const missingSessionStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    missingSessionStorage.getSession = async () => null;
    missingSessionStorage.setWorktreeOnline = async () => undefined;
    missingSessionStorage.setWorktreeOnlineFenced = async () => true;
    const missingSession = new ControlPlane({ storage: missingSessionStorage });
    missingSession.state.worktrees.set("coverage-missing-session-worktree", {
      id: "coverage-missing-session-worktree",
      name: "coverage-missing-session-worktree",
      hostId: "coverage-missing-session-host",
      repositoryId: "coverage-repo",
      path: "/tmp/coverage-missing-session",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "coverage-missing-session",
      connectionId: "coverage-missing-session-connection",
    });
    await ctx.storage.putWorktree(
      missingSession.state.worktrees.get("coverage-missing-session-worktree")!,
    );
    expect(
      await offlineHostAndRequeueDurable(
        missingSession.state,
        "coverage-missing-session-host",
        "coverage-missing-session-connection",
        "offline",
      ),
    ).toEqual([]);
    expect(missingSession.state.worktrees.get("coverage-missing-session-worktree")?.online).toBe(
      false,
    );

    const scheduleStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    scheduleStorage.tryClaimScheduleAndCreateSession = async () => false;
    const schedule = new ControlPlane({
      storage: scheduleStorage,
      idFactory: () => "coverage-schedule-session",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    schedule.state.schedules.set("coverage-optional-schedule", {
      id: "coverage-optional-schedule",
      repositoryId: "coverage-repo",
      name: "optional",
      target: { providerId: "coverage-provider" },
      fallbacks: [],
      targetLabels: ["coverage"],
      queueTtlSeconds: 691200,
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    expect(
      await tryClaimScheduleFireDurable(
        schedule.state,
        "coverage-optional-schedule",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("treats a fenced duplicate acknowledgement as an idempotent Dynamo transaction", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const hostId = "host-fenced-duplicate-ack";
    const connectionId = "connection-fenced-duplicate-ack";
    const sessionId = "session-fenced-duplicate-ack";
    const plane = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => connectionId,
    });
    expect(
      (
        await plane.registerHostDurable({
          hostId,
          worktrees: [],
          commandProfiles: [],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    await ctx.storage.putSession({
      id: sessionId,
      repositoryId: "repo-fenced-duplicate-ack",
      prompt: "ack",
      targetLabel: "ack",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId,
      worktreeId: null,
    });

    const fence = { hostId, connectionId };
    expect(await ctx.storage.acknowledgeSession(sessionId, "2026-01-01T00:00:01.000Z", fence)).toBe(
      true,
    );
    expect(await ctx.storage.acknowledgeSession(sessionId, "2026-01-01T00:00:02.000Z", fence)).toBe(
      true,
    );
    expect((await ctx.storage.getSession(sessionId))?.ackReceivedAt).toBe(
      "2026-01-01T00:00:01.000Z",
    );
  });

  it("restores confirmed sessions and releases its exact lease after a durable reconciliation read failure", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const hostId = "host-reconcile-read-failure";
    const oldConnectionId = "connection-reconcile-old";
    const newConnectionId = "connection-reconcile-new";
    const inventory = ["one", "two"].map((suffix) => ({
      id: `worktree-reconcile-${suffix}`,
      name: `worktree-reconcile-${suffix}`,
      repositoryId: "repo-reconcile-read-failure",
      path: `/tmp/reconcile-${suffix}`,
      labels: [],
    }));
    const owner = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => oldConnectionId,
    });
    expect(
      (
        await owner.registerHostDurable({
          hostId,
          worktrees: inventory,
          commandProfiles: [],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    for (const item of inventory) {
      const sessionId = `session-reconcile-${item.id.endsWith("one") ? "one" : "two"}`;
      await ctx.storage.putSession({
        id: sessionId,
        repositoryId: item.repositoryId,
        prompt: "reconnect",
        target: { commandId: "cmd-reconnect-read-failure" },
        fallbacks: [],
        targetLabels: ["reconnect"],
        queueTtlSeconds: 691200,
        queueExpiresAt: "2026-01-09T00:00:00.000Z",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        onConflict: "queue",
        status: "running",
        queueShard: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        hostId,
        worktreeId: item.id,
        attemptId: `attempt-reconcile-${item.id.endsWith("one") ? "one" : "two"}`,
        ackReceivedAt: "2026-01-01T00:00:01.000Z",
        reconnectDeadlineAt: "2026-01-01T00:01:15.000Z",
        assignmentConnectionId: oldConnectionId,
      });
      await ctx.storage.putWorktree({
        ...item,
        hostId,
        status: "busy",
        online: false,
        currentSessionId: sessionId,
        connectionId: oldConnectionId,
      });
    }

    let sessionReads = 0;
    const failingStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    failingStorage.getSession = async (sessionId: string) => {
      sessionReads++;
      if (sessionReads === 4) {
        throw new Error("injected reconciliation read failure");
      }
      return ctx.storage!.getSession(sessionId);
    };
    const replacement = new ControlPlane({
      storage: failingStorage,
      connectionIdFactory: () => newConnectionId,
    });
    await expect(
      replacement.registerHostDurable({
        hostId,
        worktrees: inventory,
        commandProfiles: [],
        runningSessions: ["session-reconcile-one", "session-reconcile-two"],
        replaceExisting: true,
      }),
    ).rejects.toThrow("injected reconciliation read failure");

    expect(await ctx.storage.getHostLock(hostId)).toBeNull();
    expect(await ctx.storage.getConnection(newConnectionId)).toBeNull();
    expect(await ctx.storage.getConnection(oldConnectionId)).toBeNull();
    expect(await ctx.storage.getSession("session-reconcile-one")).toMatchObject({
      status: "running",
      hostId,
      worktreeId: "worktree-reconcile-one",
      reconnectDeadlineAt: "2026-01-01T00:01:15.000Z",
      assignmentConnectionId: oldConnectionId,
    });
    expect(await ctx.storage.getWorktree("worktree-reconcile-one")).toMatchObject({
      status: "busy",
      online: false,
      currentSessionId: "session-reconcile-one",
      connectionId: oldConnectionId,
    });
  });

  it("offlines an omitted requeue owned by a registration that throws before release", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const hostId = "host-omitted-requeue-error";
    const oldConnectionId = "connection-omitted-requeue-old";
    const connectionId = "connection-omitted-requeue-new";
    const inventory = ["first", "second"].map((suffix) => ({
      id: `worktree-omitted-requeue-${suffix}`,
      name: `worktree-omitted-requeue-${suffix}`,
      repositoryId: "repo-omitted-requeue-error",
      path: `/tmp/omitted-requeue-${suffix}`,
      labels: [],
    }));
    const owner = new ControlPlane({
      storage: ctx.storage,
      connectionIdFactory: () => oldConnectionId,
    });
    expect(
      (
        await owner.registerHostDurable({
          hostId,
          worktrees: inventory,
          commandProfiles: [],
          replaceExisting: true,
        })
      ).ok,
    ).toBe(true);
    for (const item of inventory) {
      const suffix = item.id.endsWith("first") ? "first" : "second";
      const sessionId = `session-omitted-requeue-${suffix}`;
      await ctx.storage.putWorktree({
        ...item,
        hostId,
        status: "busy",
        online: false,
        currentSessionId: sessionId,
        connectionId: oldConnectionId,
      });
      await ctx.storage.putSession({
        id: sessionId,
        repositoryId: item.repositoryId,
        prompt: "omitted",
        target: { commandId: "cmd-omitted-requeue" },
        fallbacks: [],
        targetLabels: ["omitted"],
        queueTtlSeconds: 691200,
        queueExpiresAt: "2026-01-09T00:00:00.000Z",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        onConflict: "queue",
        status: "running",
        queueShard: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        hostId,
        worktreeId: item.id,
        attemptId: `attempt-omitted-requeue-${suffix}`,
        ackReceivedAt: "2026-01-01T00:00:01.000Z",
        assignmentConnectionId: oldConnectionId,
      });
    }

    let sessionReads = 0;
    const failingStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    failingStorage.getSession = async (sessionId: string) => {
      sessionReads++;
      if (sessionReads === 2) {
        throw new Error("injected error after omitted requeue");
      }
      return ctx.storage!.getSession(sessionId);
    };
    const registering = new ControlPlane({
      storage: failingStorage,
      connectionIdFactory: () => connectionId,
    });
    await expect(
      registering.registerHostDurable({
        hostId,
        worktrees: inventory,
        commandProfiles: [],
        runningSessions: [],
        replaceExisting: true,
      }),
    ).rejects.toThrow("injected error after omitted requeue");

    expect(await ctx.storage.getHostLock(hostId)).toBeNull();
    expect(await ctx.storage.getConnection(connectionId)).toBeNull();
    const sessions = await Promise.all(
      ["first", "second"].map((suffix) =>
        ctx.storage!.getSession(`session-omitted-requeue-${suffix}`),
      ),
    );
    const requeued = sessions.find((session) => session?.status === "queued");
    expect(requeued).toMatchObject({
      status: "queued",
      hostId: null,
      worktreeId: null,
    });
    const requeuedSuffix = requeued?.id.endsWith("first") ? "first" : "second";
    expect(
      await ctx.storage.getWorktree(`worktree-omitted-requeue-${requeuedSuffix}`),
    ).toMatchObject({
      status: "idle",
      online: false,
      currentSessionId: null,
      connectionId,
    });
    expect(sessions.filter((session) => session?.status === "running")).toHaveLength(1);
    const worktrees = await Promise.all(
      ["first", "second"].map((suffix) =>
        ctx.storage!.getWorktree(`worktree-omitted-requeue-${suffix}`),
      ),
    );
    expect(worktrees.every((worktree) => worktree?.online === false)).toBe(true);
  });
});
