import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("putSchedule / updateSchedule targeting", () => {
  it("rejects non-branch schedule refs at create and update", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    expect(
      plane.putSchedule({
        repositoryId: "repo-1",
        name: "tag-ref",
        commandId: "cmd-base",
        cron: "* * * * *",
        timeout: 1,
        nextRunAt: "t",
        ref: "refs/tags/v1",
      }),
    ).toEqual({ ok: false, error: "ref must be a valid scheduled branch name" });
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "branch-ref",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
      ref: "main",
    });
    expect(plane.updateSchedule(schedule.id, { ref: "0123456789abcdef" })).toEqual({
      ok: false,
      error: "ref must be a valid scheduled branch name",
    });
    expect(plane.getSchedule(schedule.id)?.ref).toBe("main");
  });

  it("putSchedule rejects a commandId that doesn't exist", () => {
    const plane = new ControlPlane();
    const result = plane.putSchedule({
      repositoryId: "repo-1",
      name: "n",
      commandId: "missing",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    expect(result).toEqual({ ok: false, error: "commandId missing not found" });
  });

  it("updateSchedule rejects retargeting to a commandId that doesn't exist", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    const sched = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    const result = plane.updateSchedule(sched.id, { commandId: "missing" });
    expect(result).toEqual({ ok: false, error: "commandId missing not found" });
  });

  it("updateSchedule switching commandId -> providerAccountId clears the stale commandId", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    plane.createProvider({ id: "prov-1", name: "claude", defaultCommandId: null });
    plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "x@y.com" });
    const sched = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    const result = plane.updateSchedule(sched.id, { providerAccountId: "acct-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.providerAccountId).toBe("acct-1");
      expect(result.schedule.commandId).toBeUndefined();
      expect(result.schedule.targetLabel).toBe("claude — x@y.com");
    }
  });

  it("updateSchedule switching providerAccountId -> commandId clears the stale providerAccountId", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    plane.createProvider({ id: "prov-1", name: "claude", defaultCommandId: null });
    plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "x@y.com" });
    const sched = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      providerAccountId: "acct-1",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    const result = plane.updateSchedule(sched.id, { commandId: "cmd-base" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.commandId).toBe("cmd-base");
      expect(result.schedule.providerAccountId).toBeUndefined();
    }
  });

  it("triggerSchedule forwards a providerAccountId target onto the created session", () => {
    const plane = new ControlPlane({ idFactory: () => "sess-trigger", now: () => "t" });
    plane.createProvider({ id: "prov-1", name: "claude", defaultCommandId: null });
    plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "x@y.com" });
    const sched = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      providerAccountId: "acct-1",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    const fired = plane.triggerSchedule(sched.id, "2026-01-01T00:00:00.000Z");
    expect(fired.ok).toBe(true);
    if (fired.ok) {
      expect(fired.session.providerAccountId).toBe("acct-1");
      expect(fired.session.commandId).toBeUndefined();
    }
  });

  it("evaluateCron/tryClaimScheduleFire forward a providerAccountId target onto the created session", () => {
    const plane = new ControlPlane({
      idFactory: () => "sess-cron",
      now: () => "2026-01-01T01:00:00.000Z",
      scheduleIdFactory: () => "sched-cron",
    });
    plane.createProvider({ id: "prov-1", name: "claude", defaultCommandId: null });
    plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "x@y.com" });
    putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      providerAccountId: "acct-1",
      cron: "0 * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    const created = plane.evaluateCron();
    expect(created).toHaveLength(1);
    expect(created[0]?.providerAccountId).toBe("acct-1");
  });

  it("updateSchedule leaves the target untouched when neither field is patched", () => {
    const plane = new ControlPlane();
    seedBaseCommand(plane);
    const sched = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "n",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    const result = plane.updateSchedule(sched.id, { name: "renamed" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.commandId).toBe("cmd-base");
      expect(result.schedule.name).toBe("renamed");
    }
  });

  it("keeps schedule cursors unchanged when a command or provider account is deleted", () => {
    const plane = new ControlPlane({
      scheduleIdFactory: (() => {
        let n = 0;
        return () => `stale-target-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    const commandSchedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "command",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    plane.deleteCommand("cmd-base");
    expect(plane.triggerSchedule(commandSchedule.id).ok).toBe(false);
    expect(plane.getSchedule(commandSchedule.id)?.nextRunAt).toBe("2026-01-01T00:00:00.000Z");

    plane.createProvider({ id: "prov-stale", name: "claude", defaultCommandId: null });
    plane.createProviderAccount({ id: "acct-stale", providerId: "prov-stale", label: "x@y.com" });
    const accountSchedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "account",
      providerAccountId: "acct-stale",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    plane.deleteProviderAccount("acct-stale");
    expect(
      plane.tryClaimScheduleFire(
        accountSchedule.id,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBeNull();
    expect(plane.getSchedule(accountSchedule.id)?.nextRunAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
