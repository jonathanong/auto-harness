import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";
import { setInMemoryScheduleStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";

it("hydrates workspace pools for durable schedule transitions and retains workspace fire fields", async () => {
  const plane = new ControlPlane({
    now: () => "2026-01-01T00:00:00.000Z",
    idFactory: () => "session",
    scheduleIdFactory: () => "schedule",
  });
  seedBaseCommand(plane);
  expect(
    plane.createWorkspacePool({
      id: "pool",
      name: "workspace",
      setupProfiles: [{ id: "setup", name: "Setup", script: "pnpm install" }],
      defaultSetupProfileId: "setup",
      destroyWorkspaceAfter: true,
    }).ok,
  ).toBe(true);
  const schedule = putScheduleOrThrow(plane, {
    repositoryId: "repository",
    name: "nightly",
    target: { commandId: "cmd-base" },
    cron: "* * * * *",
    timeout: 30,
  });
  const persistedPool = plane.state.workspacePools.get("pool")!;
  setInMemoryScheduleStorage(plane.state, {
    getWorkspacePool: async (id: string) => (id === "pool" ? persistedPool : null),
    listWorkspacePools: async () => [...plane.state.workspacePools.values()],
  });

  await expect(
    plane.updateScheduleDurable(schedule.id, {
      repositoryId: null,
      workspacePoolId: "pool",
      setupProfileId: "setup",
      destroyWorkspaceAfter: false,
    }),
  ).resolves.toMatchObject({
    ok: true,
    schedule: {
      repositoryId: "",
      workspacePoolId: "pool",
      setupProfileId: "setup",
      destroyWorkspaceAfter: false,
    },
  });
  plane.state.workspacePools.clear();
  await expect(plane.triggerScheduleDurable(schedule.id)).resolves.toMatchObject({
    ok: true,
    session: {
      repositoryId: null,
      type: "workspace",
      workspacePoolId: "pool",
      setupProfileId: "setup",
      destroyWorkspaceAfter: false,
    },
  });
  expect(plane.state.sessions.get("session")).toMatchObject({
    workspaceSetupScript: "pnpm install",
  });
  await expect(
    plane.updateScheduleDurable(schedule.id, {
      repositoryId: null,
      workspacePoolId: "missing",
    }),
  ).resolves.toEqual({ ok: false, error: "workspace pool not found" });
});

it("fails closed when a selected setup profile is removed before a durable fire", async () => {
  for (const fire of ["manual", "cron"] as const) {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "session",
      scheduleIdFactory: () => "schedule",
    });
    seedBaseCommand(plane);
    expect(
      plane.createWorkspacePool({
        id: "pool",
        name: "workspace",
        setupProfiles: [{ id: "setup", name: "Setup", script: "pnpm install" }],
        defaultSetupProfileId: "setup",
      }).ok,
    ).toBe(true);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: null,
      workspacePoolId: "pool",
      setupProfileId: "setup",
      name: "nightly",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
      principalId: "principal",
    });
    const removedPool = { ...plane.state.workspacePools.get("pool")!, setupProfiles: [] };
    setInMemoryScheduleStorage(plane.state, {
      getWorkspacePool: async () => removedPool,
    });
    plane.state.workspacePools.clear();
    const result =
      fire === "manual"
        ? await plane.triggerScheduleDurable(schedule.id, "2026-01-01T00:01:00.000Z")
        : await plane.tryClaimScheduleFireDurable(
            schedule.id,
            schedule.nextRunAt,
            "2026-01-01T00:01:00.000Z",
          );
    expect(result).toEqual(
      fire === "manual" ? { ok: false, error: "workspace setup profile not found" } : null,
    );
    expect([...plane.state.sessions]).toHaveLength(0);
    expect(plane.state.schedules.get(schedule.id)?.nextRunAt).toBe(schedule.nextRunAt);
  }
});
