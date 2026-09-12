import { expect, it } from "vitest";

import { setInMemoryScheduleStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import {
  deleteScheduleDurable,
  putScheduleDurable,
  updateSchedule,
} from "./control-plane-schedules.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function state() {
  const current = createControlPlaneState({ now: () => NOW, scheduleIdFactory: () => "schedule" });
  current.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  current.repositories.set("repository", {
    id: "repository",
    name: "repository",
    url: "https://example.test/repository",
    defaultBranch: "main",
    admissionState: "active",
    admissionStateChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  current.workspacePools.set("pool", {
    id: "pool",
    name: "pool",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  setInMemoryScheduleStorage(current, {
    getWorkspacePool: async (id: string) => current.workspacePools.get(id) ?? null,
  });
  return current;
}

const input = {
  name: "nightly",
  target: { commandId: "command" },
  cron: "* * * * *",
  timeout: 30,
};

it("validates durable repository and workspace schedule modes after refreshing their catalog", async () => {
  const current = state();
  await expect(
    putScheduleDurable(current, { ...input, repositoryId: "repository" }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    putScheduleDurable(current, {
      ...input,
      repositoryId: null,
      workspacePoolId: "pool",
      id: "pool-schedule",
    }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    putScheduleDurable(current, {
      ...input,
      repositoryId: null,
      workspacePoolId: "missing",
      id: "missing",
    }),
  ).resolves.toEqual({ ok: false, error: "workspace pool not found" });
});

it("retains the selected pool while updating a workspace schedule", async () => {
  const current = state();
  const created = await putScheduleDurable(current, {
    ...input,
    repositoryId: null,
    workspacePoolId: "pool",
  });
  if (!created.ok) throw new Error(created.error);
  expect(updateSchedule(current, created.schedule.id, { name: "renamed" })).toMatchObject({
    ok: true,
    schedule: { workspacePoolId: "pool" },
  });
});

it("fails closed when a workspace pool disappears between durable refresh and mode projection", async () => {
  const current = state();
  const read = current.workspacePools.get.bind(current.workspacePools);
  current.workspacePools.get = (id) => {
    const pool = read(id);
    current.workspacePools.delete(id);
    return pool;
  };
  await expect(
    putScheduleDurable(current, { ...input, repositoryId: null, workspacePoolId: "pool" }),
  ).resolves.toEqual({ ok: false, error: "workspace pool not found" });
});

it("returns not found when a durable schedule disappears after its delete fence is acquired", async () => {
  const current = state();
  const created = await putScheduleDurable(current, { ...input, repositoryId: "repository" });
  if (!created.ok) throw new Error(created.error);
  let reads = 0;
  (current.storage as { getSchedule: (id: string) => Promise<unknown> }).getSchedule = async (
    id,
  ) => {
    reads += 1;
    return reads === 1 ? (current.schedules.get(id) ?? null) : null;
  };
  await expect(deleteScheduleDurable(current, created.schedule.id)).resolves.toEqual({
    ok: false,
    error: "schedule not found",
  });
});
