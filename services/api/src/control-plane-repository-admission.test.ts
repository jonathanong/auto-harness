import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { seedBaseCommand } from "./control-plane-test-helpers.ts";
import { reconcileRepositoryDrainsDurable } from "./control-plane-repository-admission.ts";

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
});
