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
    });
    expect(schedule).not.toHaveProperty("destroyWorkspaceAfter");
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
    expect(plane.state.sessions.get("session-1")).toMatchObject({
      workspaceSetupScript: "npm install",
    });
    expect(plane.getSession("session-1")).not.toHaveProperty("workspaceSetupScript");
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

  it("rejects invalid workspace and repository mode field shapes", () => {
    const plane = workspacePlane();
    const target = { commandId: "cmd-base" };
    const repository = {
      repositoryId: "repo-1",
      name: "repository schedule",
      target,
      cron: "* * * * *",
      timeout: 30,
    };
    const workspace = {
      repositoryId: null,
      workspacePoolId: "pool-1",
      name: "workspace schedule",
      target,
      cron: "* * * * *",
      timeout: 30,
    };

    expect(plane.putSchedule({ ...repository, requiredLabels: "gpu" as never })).toEqual({
      ok: false,
      error: "requiredLabels must be an array",
    });
    expect(plane.putSchedule({ ...repository, workspacePoolId: "pool-1" })).toEqual({
      ok: false,
      error: "workspace fields require repositoryId to be null",
    });
    expect(plane.putSchedule({ ...workspace, setupProfileId: " " })).toEqual({
      ok: false,
      error: "setupProfileId must not be empty",
    });
    expect(plane.putSchedule({ ...workspace, destroyWorkspaceAfter: "yes" as never })).toEqual({
      ok: false,
      error: "destroyWorkspaceAfter must be a boolean",
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

  it("validates workspace pool profiles and carries cleanup overrides into fired sessions", () => {
    const plane = workspacePlane();
    const base = {
      repositoryId: null,
      workspacePoolId: "pool-1",
      name: "workspace cleanup",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
    };
    expect(plane.putSchedule({ ...base, workspacePoolId: "missing" })).toEqual({
      ok: false,
      error: "workspace pool not found",
    });
    expect(plane.putSchedule({ ...base, setupProfileId: "missing" })).toEqual({
      ok: false,
      error: "workspace setup profile not found",
    });
    const schedule = putScheduleOrThrow(plane, {
      ...base,
      destroyWorkspaceAfter: true,
    });
    expect(plane.triggerSchedule(schedule.id)).toMatchObject({
      ok: true,
      session: { type: "workspace", destroyWorkspaceAfter: true, workspacePoolId: "pool-1" },
    });
    const updated = plane.updateSchedule(schedule.id, {
      repositoryId: "repo-1",
      workspacePoolId: undefined,
    });
    expect(updated).toMatchObject({ ok: true, schedule: { repositoryId: "repo-1" } });
    if (updated.ok) expect(updated.schedule).not.toHaveProperty("workspacePoolId");
  });

  it("clears profile and cleanup overrides back to the current pool policy", () => {
    const plane = workspacePlane();
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: null,
      workspacePoolId: "pool-1",
      setupProfileId: "default",
      destroyWorkspaceAfter: true,
      name: "workspace policy",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 30,
    });

    const result = plane.updateSchedule(schedule.id, {
      setupProfileId: null,
      destroyWorkspaceAfter: null,
    });
    expect(result).toMatchObject({
      ok: true,
      schedule: { workspacePoolId: "pool-1" },
    });
    if (result.ok) {
      expect(result.schedule).not.toHaveProperty("setupProfileId");
      expect(result.schedule).not.toHaveProperty("destroyWorkspaceAfter");
    }
  });
});
