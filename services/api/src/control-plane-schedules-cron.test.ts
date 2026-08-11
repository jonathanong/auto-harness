import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("schedule UTC cron validation", () => {
  it("rejects an internal deletion lease as a schedule concurrency id", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    seedBaseCommand(plane);
    expect(
      plane.putSchedule({
        repositoryId: "repo",
        name: "reserved-lock",
        target: { commandId: "cmd-base" },
        cron: "* * * * *",
        timeout: 1,
        concurrencyId: "catalog-delete:repository:repo",
      }),
    ).toMatchObject({ ok: false, error: "concurrencyId uses a reserved internal prefix" });
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo",
      name: "valid-lock",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
    });
    expect(
      plane.updateSchedule(schedule.id, { concurrencyId: "catalog-delete:command:cmd-base" }),
    ).toMatchObject({ ok: false, error: "concurrencyId uses a reserved internal prefix" });
  });

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

  it("fires legacy offset cursors with their original compare-and-swap value", () => {
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
    const legacyCursor = "2026-01-01T00:00:00+00:00";
    plane.state.schedules.get(schedule.id)!.nextRunAt = legacyCursor;

    expect(plane.tryClaimScheduleFire(schedule.id, legacyCursor, now)).not.toBeNull();
    expect(plane.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("keeps manual and cron claims behind schedule state and session creation guards", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now, scheduleIdFactory: () => "schedule-1" });
    seedBaseCommand(plane);
    expect(plane.triggerSchedule("missing", now)).toEqual({
      ok: false,
      error: "schedule not found",
    });

    const disabled = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "disabled",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 60,
      enabled: false,
    });
    expect(plane.triggerSchedule(disabled.id, now)).toEqual({
      ok: false,
      error: "schedule is disabled",
    });
    expect(plane.evaluateCron(now)).toEqual([]);

    plane.state.schedules.delete(disabled.id);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 60,
    });
    const stored = plane.state.schedules.get(schedule.id)!;
    expect(plane.tryClaimScheduleFire(schedule.id, "stale-cursor", now)).toBeNull();

    stored.nextRunAt = "2026-01-02T00:00:00.000Z";
    expect(plane.tryClaimScheduleFire(schedule.id, stored.nextRunAt, now)).toBeNull();
    expect(plane.evaluateCron(now)).toEqual([]);

    stored.nextRunAt = now;
    stored.target = { commandId: "missing" };
    expect(plane.triggerSchedule(schedule.id, now)).toEqual({
      ok: false,
      error: "commandId missing not found",
    });
    expect(plane.tryClaimScheduleFire(schedule.id, now, now)).toBeNull();

    stored.target = { commandId: "cmd-base" };
    stored.repositoryId = "";
    expect(plane.triggerSchedule(schedule.id, now)).toEqual({
      ok: false,
      error: "repositoryId is required",
    });
    expect(plane.tryClaimScheduleFire(schedule.id, now, now)).toBeNull();
  });
});
