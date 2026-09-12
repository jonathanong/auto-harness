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
  setInMemoryScheduleStorage(plane.state, {
    getWorkspacePool: async (id: string) => plane.state.workspacePools.get(id) ?? null,
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
  await expect(
    plane.updateScheduleDurable(schedule.id, {
      repositoryId: null,
      workspacePoolId: "missing",
    }),
  ).resolves.toEqual({ ok: false, error: "workspace pool not found" });
});
