import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("schedule UTC cron validation", () => {
  it("rejects invalid server clocks, supplied cursors, and cron updates without changing a schedule", () => {
    let now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now, scheduleIdFactory: () => "schedule-1" });
    seedBaseCommand(plane);
    const input = {
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-base" },
      cron: "0 6 * * *",
      timeout: 60,
    };
    const schedule = putScheduleOrThrow(plane, input);

    now = "not-a-timestamp";
    expect(plane.putSchedule(input)).toEqual({
      ok: false,
      error: "server clock must be an ISO-8601 UTC timestamp",
    });
    expect(plane.updateSchedule(schedule.id, { name: "unchanged" })).toEqual({
      ok: false,
      error: "server clock must be an ISO-8601 UTC timestamp",
    });

    now = "2026-01-01T00:00:00.000Z";
    expect(plane.updateSchedule(schedule.id, { nextRunAt: "tomorrow" })).toEqual({
      ok: false,
      error: "nextRunAt must be an ISO-8601 UTC timestamp",
    });
    expect(plane.updateSchedule(schedule.id, { cron: "0 0 31 2 *" })).toEqual({
      ok: false,
      error: "cron must be a valid five-field UTC expression",
    });
    expect(plane.getSchedule(schedule.id)).toMatchObject({
      name: "nightly",
      cron: "0 6 * * *",
      nextRunAt: "2026-01-01T06:00:00.000Z",
    });
  });

  it("refuses invalid persisted cron cursors before manual or automatic firing", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now, scheduleIdFactory: () => "schedule-1" });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 60,
    });
    const stored = plane.state.schedules.get(schedule.id)!;

    stored.cron = "0 0 31 2 *";
    expect(plane.triggerSchedule(schedule.id, now)).toEqual({
      ok: false,
      error: "invalid schedule cron or timestamp",
    });
    expect(plane.tryClaimScheduleFire(schedule.id, stored.nextRunAt, now)).toBeNull();

    stored.cron = "* * * * *";
    stored.nextRunAt = "tomorrow";
    expect(plane.triggerSchedule(schedule.id, now)).toEqual({
      ok: false,
      error: "invalid schedule cron or timestamp",
    });
    expect(plane.triggerSchedule(schedule.id, "not-a-timestamp")).toEqual({
      ok: false,
      error: "invalid schedule cron or timestamp",
    });
    expect(plane.evaluateCron("not-a-timestamp")).toEqual([]);
  });
});
