import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";

function policyPlane() {
  const plane = new ControlPlane({
    now: () => "2026-01-01T00:00:00.000Z",
    idFactory: () => "session-1",
    scheduleIdFactory: () => "schedule-1",
  });
  seedBaseCommand(plane);
  expect(
    plane.createWorkspacePool({
      id: "pool-1",
      name: "isolated",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
    }).ok,
  ).toBe(true);
  return plane;
}

it("resolves an omitted cleanup override from the pool policy at fire time", () => {
  const plane = policyPlane();
  const schedule = putScheduleOrThrow(plane, {
    repositoryId: null,
    workspacePoolId: "pool-1",
    name: "workspace policy",
    target: { commandId: "cmd-base" },
    cron: "* * * * *",
    timeout: 30,
  });
  expect(schedule).not.toHaveProperty("destroyWorkspaceAfter");

  const pool = plane.state.workspacePools.get("pool-1");
  if (!pool) throw new Error("workspace pool missing");
  plane.state.workspacePools.set("pool-1", { ...pool, destroyWorkspaceAfter: true });

  expect(plane.triggerSchedule(schedule.id)).toMatchObject({
    ok: true,
    session: { type: "workspace", destroyWorkspaceAfter: true },
  });
});

it("resolves a cleared cleanup override from the pool policy at fire time", () => {
  const plane = policyPlane();
  const schedule = putScheduleOrThrow(plane, {
    repositoryId: null,
    workspacePoolId: "pool-1",
    destroyWorkspaceAfter: true,
    name: "workspace policy change",
    target: { commandId: "cmd-base" },
    cron: "* * * * *",
    timeout: 30,
  });

  const updated = plane.updateSchedule(schedule.id, { destroyWorkspaceAfter: null });
  expect(updated).toMatchObject({ ok: true });
  if (!updated.ok) return;
  expect(updated.schedule).not.toHaveProperty("destroyWorkspaceAfter");

  const pool = plane.state.workspacePools.get("pool-1");
  if (!pool) throw new Error("workspace pool missing");
  plane.state.workspacePools.set("pool-1", { ...pool, destroyWorkspaceAfter: true });

  expect(plane.triggerSchedule(schedule.id)).toMatchObject({
    ok: true,
    session: { type: "workspace", destroyWorkspaceAfter: true },
  });
});
