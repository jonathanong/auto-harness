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
      commandId: "cmd-durable",
      targetLabel: "echo",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      retryCount: 0,
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

  it("claims schedule fire once and durably requeues on disconnect", async () => {
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
      commandId: "cmd-schedule",
      targetLabel: "echo schedule",
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
      commandId: "cmd-schedule",
      targetLabel: "echo schedule",
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
      replaceExisting: true,
    });
    expect(reg.ok).toBe(true);
    await winner.hydrateFromStorage();
    const assigned = await winner.assignQueuedDurable();
    expect(assigned).toHaveLength(1);
    const sid = assigned[0]!.session.id;
    expect(
      (await winner.handleHostMessageDurable({ type: "session:ack", sessionId: sid })).ok,
    ).toBe(true);
    expect((await winner.disconnectHostDurable(reg.ok ? reg.connectionId : "missing")).length).toBe(
      1,
    );
    expect((await ctx.storage.getSession(sid))?.status).toBe("queued");
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
      commandId: "cmd-manual-durable",
      targetLabel: "manual durable",
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
    expect(Number(a.ok) + Number(b.ok)).toBe(1);
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
      commandId: "cmd-idempotent",
      targetLabel: "idempotent",
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
    expect(await planeCreated.plane.assignQueuedDurable()).toHaveLength(1);
    expect(
      await planeCreated.plane.enforceAckDeadlinesDurable(
        Date.parse("2026-01-01T00:00:01.000Z") + 10_000,
      ),
    ).toEqual(["session-idempotent"]);
    expect(await planeCreated.plane.assignQueuedDurable()).toHaveLength(1);
    expect(
      (
        await planeCreated.plane.handleHostMessageDurable({
          type: "session:ack",
          sessionId: "session-idempotent",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await planeCreated.plane.handleHostMessageDurable({
          type: "session:ack",
          sessionId: "session-idempotent",
        })
      ).ok,
    ).toBe(true);
    const terminal = {
      type: "session:status" as const,
      sessionId: "session-idempotent",
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
      commandId: "cmd-idempotent",
      targetLabel: "idempotent",
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
    failing.putWorktree = async () => {
      throw new Error("worktree write failed");
    };
    const planeCreated = new ControlPlane({
      storage: failing,
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

    const logFailing = Object.create(ctx.storage) as DynamoPlaneStorage;
    logFailing.putLog = async () => {
      throw new Error("log write failed");
    };
    await ctx.storage.putSession({
      id: "session-failing-log",
      repositoryId: "repo-failing-log",
      prompt: "log",
      targetLabel: "log",
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
      commandId: "local-durable-command",
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
      commandId: "local-durable-command",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await plane.evaluateCronDurable("2026-01-01T00:00:00.000Z")).toHaveLength(1);
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
      commandId: "coverage-command",
      targetLabel: "coverage",
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
    expect(await plane.enforceAckDeadlinesDurable(Date.parse("2026-01-01T00:00:00.000Z"))).toEqual(
      [],
    );
    const expired = {
      ...optionsSession,
      id: "coverage-expired",
      retryAfter: "2027-01-01T00:00:00.000Z",
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
      commandId: "missing",
    };
    plane.state.sessions.set(expired.id, expired);
    plane.state.sessions.set(acknowledged.id, acknowledged);
    plane.state.sessions.set(pinned.id, pinned);
    plane.state.sessions.set(missingCommand.id, missingCommand);
    await plane.assignQueuedDurable();

    const retryStatus = {
      type: "session:status" as const,
      sessionId: optionsSession.id,
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
      (await plane.handleHostMessageDurable({ type: "session:ack", sessionId: "missing" })).ok,
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
          status: "completed",
        })
      ).ok,
    ).toBe(true);

    plane.state.schedules.set("coverage-disabled", {
      id: "coverage-disabled",
      repositoryId: "coverage-repo",
      name: "disabled",
      commandId: "coverage-command",
      targetLabel: "coverage",
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
      targetLabel: "coverage",
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
    });
    expect(await offlineHostAndRequeueDurable(idle.state, "coverage-idle-host", "offline")).toEqual(
      [],
    );
    expect(idle.state.worktrees.get("coverage-idle-worktree")?.online).toBe(false);

    const missingSessionStorage = Object.create(ctx.storage) as DynamoPlaneStorage;
    missingSessionStorage.getSession = async () => null;
    missingSessionStorage.setWorktreeOnline = async () => undefined;
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
    });
    expect(
      await offlineHostAndRequeueDurable(
        missingSession.state,
        "coverage-missing-session-host",
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
      targetLabel: "coverage",
      providerAccountId: "coverage-account",
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
});
