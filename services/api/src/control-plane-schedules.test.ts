/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("schedule routing policy", () => {
  it("allows one legacy ownership claim but rejects ownership transfer", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "legacy",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
    });
    expect(plane.updateSchedule(schedule.id, { principalId: "principal-a" })).toMatchObject({
      ok: true,
      schedule: { principalId: "principal-a" },
    });
    expect(plane.updateSchedule(schedule.id, { principalId: "principal-b" })).toEqual({
      ok: false,
      error: "schedule ownership cannot be transferred",
    });
    expect(plane.updateSchedule(schedule.id, { principalId: "" })).toEqual({
      ok: false,
      error: "schedule ownership cannot be transferred",
    });
  });

  it("rejects non-branch schedule refs at create and update", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    expect(
      plane.putSchedule({
        repositoryId: "repo-1",
        name: "tag-ref",
        target: { commandId: "cmd-base" },
        cron: "* * * * *",
        timeout: 1,
        nextRunAt: "2026-01-01T00:00:00.000Z",
        ref: "refs/tags/v1",
      }),
    ).toEqual({ ok: false, error: "ref must be a valid scheduled branch name" });
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "branch-ref",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    });
    expect(plane.updateSchedule(schedule.id, { ref: "0123456789abcdef" })).toEqual({
      ok: false,
      error: "ref must be a valid scheduled branch name",
    });
    expect(plane.getSchedule(schedule.id)?.ref).toBe("main");
  });

  it("validates the primary and every fallback target", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    const base = {
      repositoryId: "repo-1",
      name: "n",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      plane.putSchedule({
        ...base,
        target: { commandId: "missing" },
      }),
    ).toEqual({ ok: false, error: "commandId missing not found" });
    expect(
      plane.putSchedule({
        ...base,
        target: { commandId: "cmd-base" },
        fallbacks: [{ commandId: "missing" }],
      }),
    ).toEqual({ ok: false, error: "commandId missing not found" });
  });

  it("rejects malformed routes, duplicates, and invalid queue TTL on create and update", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    const base = {
      repositoryId: "repo-1",
      name: "n",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    };
    expect(plane.putSchedule({ ...base, target: { providerId: "p", commandId: "c" } }).ok).toBe(
      false,
    );
    expect(
      plane.putSchedule({
        ...base,
        target: { commandId: "cmd-base" },
        fallbacks: [{ commandId: "cmd-base" }],
      }).ok,
    ).toBe(false);
    expect(
      plane.putSchedule({ ...base, target: { commandId: "cmd-base" }, queueTtlSeconds: 0 }).ok,
    ).toBe(false);
    const saved = putScheduleOrThrow(plane, { ...base, target: { commandId: "cmd-base" } });
    expect(plane.updateSchedule(saved.id, { fallbacks: "not-an-array" }).ok).toBe(false);
  });

  it("copies ordered target policy and a fresh TTL to every fire", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ idFactory: () => "sess-1", now: () => now });
    seedBaseCommand(plane);
    plane.createCommand({
      id: "cmd-base-2",
      name: "echo-2",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
    });
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      target: { commandId: "cmd-base" },
      fallbacks: [{ commandId: "cmd-base-2" }],
      cron: "* * * * *",
      timeout: 1,
      queueTtlSeconds: 10,
      nextRunAt: now,
    });
    const fired = plane.triggerSchedule(schedule.id, now);
    expect(fired.ok).toBe(true);
    if (fired.ok) {
      expect(fired.session.target).toEqual({ commandId: "cmd-base" });
      expect(fired.session.fallbacks).toEqual([{ commandId: "cmd-base-2" }]);
      expect(fired.session.queueExpiresAt).toBe("2026-01-01T00:00:10.000Z");
      expect(fired.session.scheduleId).toBe(schedule.id);
    }
  });

  it("updates an entire target chain", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    const result = plane.updateSchedule(schedule.id, { fallbacks: [{ commandId: "missing" }] });
    expect(result).toEqual({ ok: false, error: "commandId missing not found" });
  });

  it("rejects a schedule fire when a stored target is no longer catalogued", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const plane = new ControlPlane({ now: () => now, scheduleIdFactory: () => "schedule-1" });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: now,
    });
    plane.state.schedules.get(schedule.id)!.target = { commandId: "deleted" };

    expect(plane.triggerSchedule(schedule.id, now)).toEqual({
      ok: false,
      error: "commandId deleted not found",
    });
    expect(plane.tryClaimScheduleFire(schedule.id, now, now)).toBeNull();
  });

  it("derives the UTC cursor on create, update, manual trigger, and delayed cron fire", () => {
    const createdAt = "2026-01-01T05:30:00.000Z";
    const plane = new ControlPlane({ now: () => createdAt, scheduleIdFactory: () => "daily" });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "daily",
      target: { commandId: "cmd-base" },
      cron: "0 6 * * *",
      timeout: 1,
      nextRunAt: "2030-01-01T00:00:00.000Z",
    });
    expect(schedule.nextRunAt).toBe("2026-01-01T06:00:00.000Z");
    expect(plane.evaluateCron("2026-01-01T07:00:00.000Z")).toHaveLength(1);
    expect(plane.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-02T06:00:00.000Z");

    const updated = plane.updateSchedule(schedule.id, {
      cron: "0 18 * * *",
      nextRunAt: "2030-01-01T00:00:00.000Z",
    });
    expect(updated).toMatchObject({
      ok: true,
      schedule: { nextRunAt: "2026-01-01T18:00:00.000Z" },
    });
    plane.state.sessions.clear();
    expect(plane.triggerSchedule(schedule.id, "2026-01-01T19:00:00.000Z")).toMatchObject({
      ok: true,
      created: true,
    });
    expect(plane.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-02T18:00:00.000Z");
  });

  it("rejects malformed cron expressions and supplied timestamps", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    seedBaseCommand(plane);
    const input = {
      repositoryId: "repo-1",
      name: "invalid",
      target: { commandId: "cmd-base" },
      timeout: 1,
    };
    expect(plane.putSchedule({ ...input, cron: "* * * *" }).ok).toBe(false);
    expect(plane.putSchedule({ ...input, cron: "* * * * *", nextRunAt: "tomorrow" })).toMatchObject(
      { ok: false, error: "nextRunAt must be an ISO-8601 UTC timestamp" },
    );
  });
});
