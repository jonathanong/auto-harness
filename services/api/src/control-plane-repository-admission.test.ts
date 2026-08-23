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
        listSessionsByRepository: async () => [],
        listWorktreesForRepo: async () => [],
        completeRepositoryDrain: async () => completed,
      },
    } as never;
    await expect(reconcileRepositoryDrainsDurable(state)).resolves.toEqual([completed]);
    expect(repositories.get("repo-1")).toEqual(completed);
  });
});
