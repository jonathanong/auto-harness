/* eslint-disable max-lines -- admission state cases share one control-plane fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { seedBaseCommand } from "./control-plane-test-helpers.ts";
import {
  drainRepositoryDurable,
  reconcileRepositoryDrainsDurable,
  setRepositoryAdmissionDurable,
} from "./control-plane-repository-admission.ts";

describe("repository admission", () => {
  it("pauses creation, activates again, and drains active sessions to paused", async () => {
    let tick = 0;
    const plane = new ControlPlane({
      now: () => `2026-01-01T00:00:0${tick++}.000Z`,
      idFactory: () => `session-${tick}`,
    });
    seedBaseCommand(plane);
    expect(
      plane.createRepository({ id: "repo-1", name: "repo", url: "https://example.test/repo" }).ok,
    ).toBe(true);
    const first = plane.createSession({
      repositoryId: "repo-1",
      prompt: "run",
      target: { commandId: "cmd-base" },
      timeout: 30,
    });
    expect(first.ok).toBe(true);

    const paused = await plane.pauseRepositoryDurable("repo-1");
    expect(paused).toMatchObject({ ok: true, repository: { admissionState: "paused" } });
    expect(
      plane.createSession({
        repositoryId: "repo-1",
        prompt: "blocked",
        target: { commandId: "cmd-base" },
        timeout: 30,
      }),
    ).toMatchObject({ ok: false, code: "REPOSITORY_ADMISSION_CLOSED" });

    expect(await plane.activateRepositoryDurable("repo-1")).toMatchObject({
      ok: true,
      repository: { admissionState: "active" },
    });
    const drained = await plane.drainRepositoryDurable("repo-1");
    expect(drained).toMatchObject({
      ok: true,
      repository: { admissionState: "paused", drainCompletedAt: expect.any(String) },
    });
    if (first.ok) expect(plane.getSession(first.session.id)?.status).toBe("cancelled");
  });

  it("hides missing repositories and refuses to activate an unfinished drain", async () => {
    const plane = new ControlPlane();
    expect(await plane.pauseRepositoryDurable("missing")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    plane.createRepository({ id: "repo-1", name: "repo", url: "url" });
    plane.state.repositories.get("repo-1")!.admissionState = "draining";
    expect(await plane.activateRepositoryDurable("repo-1")).toMatchObject({
      ok: false,
      code: "CONFLICT",
    });
  });

  it("keeps an in-memory drain open until its worktree lease is released", async () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({ onHostMessage: (_hostId, message) => messages.push(message) });
    seedBaseCommand(plane);
    plane.createRepository({ id: "repo-1", name: "repo", url: "url" });
    const created = plane.createSession({
      repositoryId: "repo-1",
      prompt: "run",
      target: { commandId: "cmd-base" },
      timeout: 30,
    });
    if (!created.ok) throw new Error(created.error);
    const session = plane.state.sessions.get(created.session.id)!;
    session.status = "running";
    session.hostId = "host-1";
    session.worktreeId = "worktree-1";
    plane.seedWorktree({
      id: "worktree-1",
      name: "worktree",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: session.id,
    });

    await expect(plane.drainRepositoryDurable("repo-1")).resolves.toMatchObject({
      ok: true,
      repository: { admissionState: "draining" },
    });
    expect(messages).toContainEqual({ type: "session:cancel", sessionId: session.id });
    delete plane.state.worktrees.get("worktree-1")!.currentSessionId;
    await expect(plane.reconcileRepositoryDrainsDurable()).resolves.toMatchObject([
      { admissionState: "paused" },
    ]);
  });

  it("keeps an in-memory drain open while a main-checkout lease remains", async () => {
    const plane = new ControlPlane({
      onHostMessage: () => undefined,
    });
    seedBaseCommand(plane);
    plane.createRepository({ id: "repo-main", name: "repo", url: "url" });
    const created = plane.createSession({
      repositoryId: "repo-main",
      prompt: "run",
      target: { commandId: "cmd-base" },
      timeout: 30,
    });
    if (!created.ok) throw new Error(created.error);
    const session = plane.state.sessions.get(created.session.id)!;
    session.status = "running";
    session.hostId = "host-1";
    plane.state.mainCheckoutLeases.set("host-1\0repo-main", {
      sessionId: session.id,
      connectionId: "connection-1",
    });

    await expect(plane.drainRepositoryDurable("repo-main")).resolves.toMatchObject({
      ok: true,
      repository: { admissionState: "draining" },
    });
    plane.state.mainCheckoutLeases.delete("host-1\0repo-main");
    await expect(plane.reconcileRepositoryDrainsDurable()).resolves.toMatchObject([
      { admissionState: "paused" },
    ]);
  });

  it("advances due closed schedule cursors before activation", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:05:00.000Z" });
    seedBaseCommand(plane);
    plane.createRepository({ id: "repo-1", name: "repo", url: "url" });
    await plane.pauseRepositoryDurable("repo-1");
    expect(
      plane.putSchedule({
        id: "schedule-1",
        repositoryId: "repo-1",
        name: "schedule",
        target: { commandId: "cmd-base" },
        cron: "* * * * *",
        timeout: 30,
        nextRunAt: "2026-01-01T00:01:00.000Z",
      }).ok,
    ).toBe(true);
    await expect(plane.activateRepositoryDurable("repo-1")).resolves.toMatchObject({ ok: true });
    expect(plane.getSchedule("schedule-1")?.nextRunAt).toBe("2026-01-01T00:06:00.000Z");
  });

  it("reconciles a durable drain after leases clear", async () => {
    const draining = {
      id: "repo-1",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
      admissionState: "draining" as const,
      drainRequestedAt: "requested",
    };
    const completed = { ...draining, admissionState: "paused" as const };
    const repositories = new Map();
    const state = {
      now: () => "completed",
      repositories,
      storage: {
        listRepositories: async () => [draining],
        listAllSessions: async () => [],
        listWorktreesForRepo: async () => [],
        completeRepositoryDrain: async () => completed,
      },
    } as never;
    await expect(reconcileRepositoryDrainsDurable(state)).resolves.toEqual([completed]);
    expect(repositories.get("repo-1")).toEqual(completed);
  });

  it("skips malformed durable admission rows without aborting healthy drains", async () => {
    const draining = {
      id: "repo-draining",
      admissionState: "draining" as const,
      drainRequestedAt: "requested",
    };
    const malformed = {
      ...draining,
      id: "repo-malformed",
      admissionState: "unknown" as never,
    };
    const completed = { ...draining, admissionState: "paused" as const };
    const completedIds: string[] = [];
    const repositories = new Map();
    const state = {
      now: () => "completed",
      repositories,
      storage: {
        listRepositories: async () => [malformed, draining],
        listAllSessions: async () => [],
        listWorktreesForRepo: async () => [],
        completeRepositoryDrain: async (id: string) => {
          completedIds.push(id);
          return id === draining.id ? completed : null;
        },
      },
    } as never;

    await expect(reconcileRepositoryDrainsDurable(state)).resolves.toEqual([completed]);
    expect(completedIds).toEqual([draining.id]);
    expect(repositories.get(malformed.id)).toBeUndefined();
  });

  it("covers durable admission transition and reconciliation edge outcomes", async () => {
    const repository = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
      admissionState: "paused" as const,
    };
    const storage = {
      getRepository: async () => null as typeof repository | null,
      setRepositoryAdmissionState: async () => null as typeof repository | null,
      listSchedules: async () => [],
    };
    const state = {
      now: () => "2026-01-01T00:05:00.000Z",
      repositories: new Map(),
      schedules: new Map(),
      repositoryRevision: 0,
      storage,
    } as never;
    await expect(setRepositoryAdmissionDurable(state, "missing", "active")).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });

    storage.getRepository = async () => ({ ...repository, admissionState: "draining" });
    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
    });

    storage.setRepositoryAdmissionState = async () => repository;
    await expect(setRepositoryAdmissionDurable(state, "repo", "paused")).resolves.toMatchObject({
      ok: true,
    });
    storage.setRepositoryAdmissionState = async () => null;
    storage.getRepository = async () => repository;
    await expect(setRepositoryAdmissionDurable(state, "repo", "paused")).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
    });

    storage.getRepository = async () => ({
      ...repository,
      admissionState: "active",
      activationCutoffAt: "winner",
    });
    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: true,
      repository: { activationCutoffAt: "winner" },
    });

    storage.setRepositoryAdmissionState = async () => null;
    await expect(drainRepositoryDurable(state, "missing")).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    storage.getRepository = async () => null;
    await expect(setRepositoryAdmissionDurable(state, "missing", "paused")).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });

    const memory = {
      now: () => "now",
      repositories: new Map(),
      repositoryRevision: 0,
    } as never;
    await expect(drainRepositoryDurable(memory, "missing")).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("skips ineligible schedules and retains durable drains with leases or failed completion", async () => {
    const draining = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
      admissionState: "draining" as const,
      drainRequestedAt: "requested",
    };
    let sessions: Array<Record<string, unknown>> = [
      { id: "terminal", repositoryId: "repo", status: "completed" },
      { id: "lease", repositoryId: "repo", status: "completed", mainCheckoutLease: true },
    ];
    const storage = {
      listRepositories: async () => [draining],
      listAllSessions: async () => sessions,
      listWorktreesForRepo: async () => [],
      completeRepositoryDrain: async () => null,
    };
    const state = {
      now: () => "completed",
      repositories: new Map(),
      storage,
    } as never;
    await expect(reconcileRepositoryDrainsDurable(state)).resolves.toEqual([draining]);
    sessions = [];
    await expect(reconcileRepositoryDrainsDurable(state)).resolves.toEqual([draining]);

    const noRequest = { ...draining, drainRequestedAt: undefined };
    storage.listRepositories = async () => [noRequest as never];
    await expect(reconcileRepositoryDrainsDurable(state)).resolves.toEqual([noRequest]);
  });

  it("advances only eligible durable closed schedules and completes a durable drain", async () => {
    const paused = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
      admissionState: "paused" as const,
    };
    const active = { ...paused, admissionState: "active" as const };
    const draining = {
      ...paused,
      admissionState: "draining" as const,
      drainRequestedAt: "requested",
    };
    const skipped: string[] = [];
    let dueNextRunAt = "2026-01-01T00:00:00.000Z";
    const storage = {
      getRepository: async () => paused,
      listSchedules: async () => [
        {
          id: "due",
          repositoryId: "repo",
          enabled: true,
          nextRunAt: dueNextRunAt,
          cron: "* * * * *",
        },
        {
          id: "wrong",
          repositoryId: "other",
          enabled: true,
          nextRunAt: "2026-01-01T00:00:00.000Z",
          cron: "* * * * *",
        },
        {
          id: "disabled",
          repositoryId: "repo",
          enabled: false,
          nextRunAt: "2026-01-01T00:00:00.000Z",
          cron: "* * * * *",
        },
        {
          id: "future",
          repositoryId: "repo",
          enabled: true,
          nextRunAt: "2026-01-01T00:10:00.000Z",
          cron: "* * * * *",
        },
        {
          id: "invalid",
          repositoryId: "repo",
          enabled: true,
          nextRunAt: "2026-01-01T00:00:00.000Z",
          cron: "invalid",
        },
      ],
      skipScheduleForClosedRepository: async ({
        scheduleId,
        newNextRunAt,
      }: {
        scheduleId: string;
        newNextRunAt: string;
      }) => {
        skipped.push(scheduleId);
        dueNextRunAt = newNextRunAt;
        return true;
      },
      setRepositoryAdmissionState: async (_id: string, state: string) =>
        state === "draining" ? draining : active,
      listAllSessions: async () => [],
      listWorktreesForRepo: async () => [],
      completeRepositoryDrain: async () => paused,
    };
    const state = {
      now: () => "2026-01-01T00:05:00.000Z",
      repositories: new Map([["repo", paused]]),
      schedules: new Map(),
      sessions: new Map(),
      worktrees: new Map(),
      repositoryRevision: 0,
      storage,
    } as never;
    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: true,
    });
    expect(skipped).toEqual(["due"]);
    await expect(drainRepositoryDurable(state, "repo")).resolves.toMatchObject({ ok: true });
  });

  it("retries a pause that races a non-reopening activation as a fresh reopening", async () => {
    let repository = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "created",
      updatedAt: "created",
      admissionState: "active" as const,
    };
    let schedule = {
      id: "schedule",
      repositoryId: "repo",
      enabled: true,
      nextRunAt: "2026-01-01T00:01:00.000Z",
      cron: "* * * * *",
    };
    const writes: Array<{ at: string; cutoff?: string }> = [];
    let scans = 0;
    const timestamps = [
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:06:00.000Z",
      "2026-01-01T00:06:00.000Z",
      "2026-01-01T00:07:00.000Z",
    ];
    const storage = {
      getRepository: async () => ({ ...repository }),
      listSchedules: async () => {
        scans += 1;
        return [{ ...schedule }];
      },
      skipScheduleForClosedRepository: async ({
        expectedNextRunAt,
        newNextRunAt,
      }: {
        expectedNextRunAt: string;
        newNextRunAt: string;
      }) => {
        if (repository.admissionState !== "paused" || schedule.nextRunAt !== expectedNextRunAt)
          return false;
        schedule = { ...schedule, nextRunAt: newNextRunAt };
        return true;
      },
      setRepositoryAdmissionState: async (
        _id: string,
        _state: string,
        at: string,
        cutoff?: string,
      ) => {
        writes.push({ at, cutoff });
        if (writes.length === 1) {
          repository = { ...repository, admissionState: "paused" };
          return null;
        }
        repository = {
          ...repository,
          admissionState: "active",
          activationCutoffAt: cutoff,
          updatedAt: at,
        };
        return { ...repository };
      },
    };
    const state = {
      now: () => timestamps.shift() ?? "unexpected",
      repositories: new Map(),
      schedules: new Map(),
      repositoryRevision: 0,
      storage,
    } as never;

    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: true,
      repository: {
        admissionState: "active",
        activationCutoffAt: "2026-01-01T00:07:00.000Z",
      },
    });
    expect(writes).toEqual([
      { at: "2026-01-01T00:05:00.000Z", cutoff: undefined },
      { at: "2026-01-01T00:07:00.000Z", cutoff: "2026-01-01T00:07:00.000Z" },
    ]);
    expect(scans).toBe(4);
  });

  it("returns the concurrent active winner after a non-reopening activation loses", async () => {
    const initial = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "created",
      updatedAt: "created",
      admissionState: "active" as const,
    };
    const winner = { ...initial, updatedAt: "winner" };
    let reads = 0;
    let writes = 0;
    const state = {
      now: () => "2026-01-01T00:05:00.000Z",
      repositories: new Map(),
      schedules: new Map(),
      repositoryRevision: 0,
      storage: {
        getRepository: async () => ({ ...(reads++ === 0 ? initial : winner) }),
        listSchedules: async () => [],
        setRepositoryAdmissionState: async () => {
          writes += 1;
          return null;
        },
      },
    } as never;

    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: true,
      repository: winner,
    });
    expect(writes).toBe(1);
  });

  it("keeps a lost pause write conflicting even when another writer leaves the row active", async () => {
    const active = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "created",
      updatedAt: "winner",
      admissionState: "active" as const,
    };
    let writes = 0;
    const state = {
      now: () => "2026-01-01T00:05:00.000Z",
      repositories: new Map(),
      schedules: new Map(),
      repositoryRevision: 0,
      storage: {
        getRepository: async () => ({ ...active }),
        setRepositoryAdmissionState: async () => {
          writes += 1;
          return null;
        },
      },
    } as never;

    await expect(setRepositoryAdmissionDurable(state, "repo", "paused")).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
    });
    expect(writes).toBe(1);
  });

  it("reports drain and deletion winners after a non-reopening activation loses", async () => {
    const initial = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "created",
      updatedAt: "created",
      admissionState: "active" as const,
    };
    for (const winner of [{ ...initial, admissionState: "draining" as const }, null]) {
      let reads = 0;
      let writes = 0;
      const state = {
        now: () => "2026-01-01T00:05:00.000Z",
        repositories: new Map(),
        schedules: new Map(),
        repositoryRevision: 0,
        storage: {
          getRepository: async () => {
            reads += 1;
            return reads === 1 ? { ...initial } : winner && { ...winner };
          },
          listSchedules: async () => [],
          setRepositoryAdmissionState: async () => {
            writes += 1;
            return null;
          },
        },
      } as never;

      await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject(
        winner ? { ok: false, code: "CONFLICT" } : { ok: false, code: "NOT_FOUND" },
      );
      expect(writes).toBe(1);
    }
  });

  it("bounds a pause-race activation retry when the reopening write also loses", async () => {
    let repository = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "created",
      updatedAt: "created",
      admissionState: "active" as const,
    };
    let writes = 0;
    let scans = 0;
    const storage = {
      getRepository: async () => ({ ...repository }),
      listSchedules: async () => {
        scans += 1;
        return [];
      },
      setRepositoryAdmissionState: async () => {
        writes += 1;
        repository = { ...repository, admissionState: "paused" };
        return null;
      },
    };
    const state = {
      now: () => "2026-01-01T00:05:00.000Z",
      repositories: new Map(),
      schedules: new Map(),
      repositoryRevision: 0,
      storage,
    } as never;

    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
    });
    expect(writes).toBe(2);
    expect(scans).toBe(4);
  });

  it("treats a legacy missing admission state as an active non-reopening row", async () => {
    const legacy = {
      id: "repo",
      name: "repo",
      url: "url",
      defaultBranch: "main",
      createdAt: "created",
      updatedAt: "created",
    };
    const cutoffs: Array<string | undefined> = [];
    const state = {
      now: () => "2026-01-01T00:05:00.000Z",
      repositories: new Map(),
      schedules: new Map(),
      repositoryRevision: 0,
      storage: {
        getRepository: async () => ({ ...legacy }),
        listSchedules: async () => [],
        setRepositoryAdmissionState: async (
          _id: string,
          _state: string,
          _at: string,
          cutoff?: string,
        ) => {
          cutoffs.push(cutoff);
          return { ...legacy, admissionState: "active" as const };
        },
      },
    } as never;

    await expect(setRepositoryAdmissionDurable(state, "repo", "active")).resolves.toMatchObject({
      ok: true,
      repository: { admissionState: "active" },
    });
    expect(cutoffs).toEqual([undefined]);
  });
});
