import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  triggerScheduleDurable,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

function makeDurableSchedulePlane() {
  const plane = new ControlPlane({
    idFactory: () => "scheduled-session",
    scheduleIdFactory: () => "nightly",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  seedBaseCommand(plane);
  const schedule = putScheduleOrThrow(plane, {
    repositoryId: "repo-1",
    name: "nightly",
    target: { commandId: "cmd-base" },
    cron: "* * * * *",
    timeout: 1,
    nextRunAt: "2026-01-01T00:00:00.000Z",
  });
  const active = {
    id: "active-session",
    repositoryId: "repo-1",
    prompt: "scheduled:nightly",
    target: { commandId: "cmd-base" },
    fallbacks: [],
    targetLabels: ["base"],
    queueTtlSeconds: 691_200,
    queueExpiresAt: "2026-01-08T00:00:00.000Z",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    status: "running" as const,
    queueShard: 0,
    createdAt: "2025-12-31T23:59:00.000Z",
    retryCount: 0,
    concurrencyId: "schedule-nightly",
  };
  return { plane, schedule, active };
}

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
      target: { commandId: "cmd-base" },
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
      target: { commandId: "cmd-base" },
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
      target: { commandId: "cmd-base" },
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

  it("handles every durable overlap claim outcome", async () => {
    const manual = makeDurableSchedulePlane();
    manual.plane.createProvider({
      id: "provider-1",
      name: "provider",
      defaultCommandId: "cmd-base",
    });
    manual.plane.createProviderAccount({
      id: "account-1",
      providerId: "provider-1",
      label: "account",
    });
    expect(
      manual.plane.updateSchedule(manual.schedule.id, {
        target: { providerId: "provider-1" },
        ref: "main",
      }),
    ).toMatchObject({ ok: true });
    manual.plane.state.storage = {
      tryClaimScheduleAndCreateSession: async () => ({
        kind: "duplicate",
        session: manual.active,
      }),
    } as never;
    await expect(
      triggerScheduleDurable(manual.plane.state, manual.schedule.id, "2026-01-01T00:00:30.000Z"),
    ).resolves.toMatchObject({ ok: true, created: false, session: { id: "active-session" } });
    expect(manual.plane.getSchedule(manual.schedule.id)?.nextRunAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );

    for (const skipped of [true, false]) {
      const cron = makeDurableSchedulePlane();
      cron.plane.state.storage = {
        tryClaimScheduleAndCreateSession: async () => ({
          kind: "duplicate",
          session: cron.active,
        }),
        skipScheduleForActiveConcurrency: async () => skipped,
      } as never;
      await expect(
        tryClaimScheduleFireDurable(
          cron.plane.state,
          cron.schedule.id,
          cron.schedule.nextRunAt,
          "2026-01-01T00:00:00.000Z",
        ),
      ).resolves.toBeNull();
      expect(cron.plane.getSchedule(cron.schedule.id)?.nextRunAt).toBe(
        skipped ? "2026-01-01T00:01:00.000Z" : "2026-01-01T00:00:00.000Z",
      );
    }

    const lost = makeDurableSchedulePlane();
    lost.plane.state.storage = {
      tryClaimScheduleAndCreateSession: async () => ({ kind: "lost" }),
    } as never;
    await expect(triggerScheduleDurable(lost.plane.state, lost.schedule.id)).resolves.toEqual({
      ok: false,
      error: "schedule was updated or claimed concurrently",
    });
    await expect(
      tryClaimScheduleFireDurable(
        lost.plane.state,
        lost.schedule.id,
        lost.schedule.nextRunAt,
        "2026-01-01T00:00:00.000Z",
      ),
    ).resolves.toBeNull();

    const fallback = makeDurableSchedulePlane();
    await expect(
      tryClaimScheduleFireDurable(
        fallback.plane.state,
        fallback.schedule.id,
        fallback.schedule.nextRunAt,
        "2026-01-01T00:00:00.000Z",
      ),
    ).resolves.toMatchObject({ id: "scheduled-session" });
  });
});
