import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";

function workspacePlane() {
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
      setupProfiles: [{ id: "default", name: "Default", script: "npm install" }],
      defaultSetupProfileId: "default",
      destroyWorkspaceAfter: false,
    }).ok,
  ).toBe(true);
  return plane;
}

describe("workspace schedules", () => {
  it("persists workspace fields and fires a workspace session", () => {
    const plane = workspacePlane();
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: null,
      workspacePoolId: "pool-1",
      setupProfileId: "default",
      name: "workspace check",
      prompt: "run workspace check",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
    });
    expect(schedule).toMatchObject({
      repositoryId: "",
      workspacePoolId: "pool-1",
      setupProfileId: "default",
      destroyWorkspaceAfter: false,
    });
    expect(plane.triggerSchedule(schedule.id)).toMatchObject({
      ok: true,
      session: {
        repositoryId: null,
        workspacePoolId: "pool-1",
        setupProfileId: "default",
        type: "workspace",
        source: "schedule",
      },
    });
  });

  it("rejects repository-only and raw execution fields", () => {
    const plane = workspacePlane();
    const base = {
      repositoryId: null,
      workspacePoolId: "pool-1",
      name: "workspace check",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
    };
    expect(plane.putSchedule({ ...base, ref: "main" })).toEqual({
      ok: false,
      error: "ref is not supported for workspace schedules",
    });
    expect(plane.putSchedule({ ...base, requiredLabels: ["gpu"] })).toEqual({
      ok: false,
      error: "requiredLabels are not supported by schedule inputs",
    });
    expect(plane.putSchedule({ ...base, setupScript: "rm -rf /" })).toEqual({
      ok: false,
      error: "setupScript is not accepted by schedule inputs",
    });
  });

  it("preserves repository schedules", () => {
    const plane = workspacePlane();
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "repository check",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
      ref: "main",
    });
    expect(schedule).toMatchObject({ repositoryId: "repo-1", ref: "main" });
    expect(
      plane.updateSchedule(schedule.id, { repositoryId: null, workspacePoolId: "pool-1" }),
    ).toMatchObject({
      ok: true,
      schedule: { repositoryId: "", workspacePoolId: "pool-1" },
    });
  });
});
