import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("schedule concurrency", () => {
  it("skips an overlapping cron occurrence without recording a run", () => {
    let sessionNumber = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++sessionNumber}`,
      scheduleIdFactory: () => "nightly",
    });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "nightly",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(schedule.concurrencyId).toBe("schedule-nightly");
    expect(plane.evaluateCron("2026-01-01T00:00:00.000Z")).toHaveLength(1);
    expect(plane.evaluateCron("2026-01-01T00:01:00.000Z")).toHaveLength(0);
    expect(plane.getSchedule(schedule.id)).toMatchObject({
      nextRunAt: "2026-01-01T00:02:00.000Z",
      lastRunAt: "2026-01-01T00:00:00.000Z",
      activeSessionId: "sess-1",
    });
  });

  it("restores the generated concurrency id when an override is cleared", () => {
    const plane = new ControlPlane({ scheduleIdFactory: () => "nightly" });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "nightly",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      concurrencyId: " custom ",
    });
    expect(schedule.concurrencyId).toBe("custom");
    expect(plane.updateSchedule(schedule.id, { concurrencyId: "  " })).toMatchObject({
      ok: true,
      schedule: { concurrencyId: "schedule-nightly" },
    });
  });

  it("returns the active session without moving the cursor on a repeated manual trigger", () => {
    let id = 0;
    const plane = new ControlPlane({
      idFactory: () => `manual-${++id}`,
      scheduleIdFactory: () => "manual",
    });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "manual",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2030-01-01T00:00:00.000Z",
    });
    expect(plane.triggerSchedule(schedule.id, "2026-01-01T00:00:00.000Z")).toMatchObject({
      ok: true,
      created: true,
    });
    const cursor = plane.getSchedule(schedule.id)?.nextRunAt;
    expect(plane.triggerSchedule(schedule.id, "2026-01-01T00:00:30.000Z")).toMatchObject({
      ok: true,
      created: false,
      session: { id: "manual-1" },
    });
    expect(plane.getSchedule(schedule.id)?.nextRunAt).toBe(cursor);
  });
});
