/* eslint-disable max-lines -- schedule-fire coverage cases share one fixture. */
import { describe, expect, it } from "vitest";

import { setInMemoryScheduleStorage } from "./control-plane-durable-read-test-helpers.ts";
import {
  evaluateCronDurable,
  triggerScheduleDurable,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { ScheduleRecord } from "./control-plane-types.ts";
import { putScheduleDurable } from "./control-plane-schedules.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "nightly",
    repositoryId: "repo",
    name: "nightly",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    cron: "* * * * *",
    enabled: true,
    timeout: 30,
    queueTtlSeconds: 3600,
    nextRunAt: NOW,
    lastRunAt: null,
    createdAt: NOW,
    ...over,
  };
}

function state(row: ScheduleRecord, storage: object = {}) {
  const current = createControlPlaneState({ idFactory: () => "run", now: () => NOW });
  current.repositories.set(row.repositoryId, {
    id: row.repositoryId,
    name: row.repositoryId,
    url: `https://example.test/${row.repositoryId}`,
    defaultBranch: "main",
    admissionState: "active",
    admissionStateChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  current.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  current.schedules.set(row.id, row);
  setInMemoryScheduleStorage(current, storage as Record<string, unknown>);
  return current;
}

describe("schedule fire residual coverage", () => {
  it("rejects missing, closed, and invalid durable schedule repositories", async () => {
    const missing = createControlPlaneState();
    await expect(
      putScheduleDurable(missing, {
        repositoryId: "missing",
        name: "schedule",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).resolves.toMatchObject({ ok: false, error: "repository not found" });

    const closed = state(schedule({ principalId: "principal" }));
    closed.repositories.get("repo")!.admissionState = "paused";
    await expect(
      putScheduleDurable(closed, {
        repositoryId: "repo",
        name: "schedule",
        target: { commandId: "cmd" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).resolves.toMatchObject({ ok: false });

    const invalid = state(schedule({ principalId: "principal" }));
    await expect(
      putScheduleDurable(invalid, {
        repositoryId: "repo",
        name: "schedule",
        target: { commandId: "missing" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).resolves.toMatchObject({ ok: false, error: "commandId missing not found" });
  });

  it("distinguishes a missing durable repository from closed admission", async () => {
    const missing = state(schedule({ principalId: "principal" }));
    missing.repositories.clear();
    await expect(triggerScheduleDurable(missing, "nightly")).resolves.toEqual({
      ok: false,
      error: "repository admission is closed",
    });

    const closed = state(schedule({ principalId: "principal" }), {
      tryClaimScheduleAndCreateSession: async () => ({ kind: "admission_closed" }),
    });
    await expect(triggerScheduleDurable(closed, "nightly")).resolves.toEqual({
      ok: false,
      error: "repository admission is closed",
    });
  });

  it("consumes durable cron occurrences rejected by the admission transaction", async () => {
    for (const skipped of [false, true]) {
      const current = state(schedule({ principalId: "principal" }), {
        tryClaimScheduleAndCreateSession: async () => ({ kind: "admission_closed" }),
        skipScheduleForClosedRepository: async () => skipped,
      });
      await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
      expect(current.schedules.get("nightly")?.nextRunAt).toBe(
        skipped ? "2026-01-01T00:01:00.000Z" : NOW,
      );
    }
  });

  it("rejects a disabled durable manual trigger", async () => {
    await expect(
      triggerScheduleDurable(state(schedule({ enabled: false })), "nightly"),
    ).resolves.toEqual({
      ok: false,
      error: "schedule is disabled",
    });
  });

  it("rejects an ownerless legacy schedule before a durable manual trigger", async () => {
    await expect(triggerScheduleDurable(state(schedule()), "nightly")).resolves.toEqual({
      ok: false,
      error: "schedule must be claimed by an authenticated principal",
    });
  });

  it("rejects an invalid persisted cursor before a durable claim", async () => {
    const current = state(schedule({ nextRunAt: "not-a-time", principalId: "principal" }));
    await expect(triggerScheduleDurable(current, "nightly")).resolves.toEqual({
      ok: false,
      error: "invalid schedule cron or timestamp",
    });
  });

  it("returns no durable cron work for a malformed evaluation timestamp", async () => {
    await expect(evaluateCronDurable(state(schedule()), "not-a-time")).resolves.toEqual([]);
  });

  it("returns null when a durable fire loses the schedule cursor", async () => {
    const current = state(schedule({ principalId: "principal" }), {
      tryClaimScheduleAndCreateSession: async () => ({ kind: "stale" }),
    });
    await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
  });

  it("returns null when a claimed schedule no longer has a valid cron", async () => {
    const current = state(schedule({ cron: "invalid", principalId: "principal" }));
    await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
  });

  it("consumes and audits an ownerless legacy cron occurrence", async () => {
    let claims = 0;
    let skipped = 0;
    const current = state(schedule(), {
      tryClaimScheduleAndCreateSession: async () => {
        claims += 1;
        return { kind: "created" };
      },
      skipOwnerlessScheduleAndAudit: async () => {
        skipped += 1;
        return true;
      },
    });

    await expect(evaluateCronDurable(current, NOW)).resolves.toEqual([]);
    expect(claims).toBe(0);
    expect(skipped).toBe(1);
    expect(current.schedules.get("nightly")).toMatchObject({
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: NOW,
    });
    expect([...current.auditLogs.values()]).toContainEqual(
      expect.objectContaining({
        action: "schedule:ownerless-occurrence-skipped",
        resourceType: "schedule",
        resourceId: "nightly",
        outcome: "failed",
      }),
    );
  });

  it("leaves a due ownerless occurrence for a concurrent ownership claim", async () => {
    const current = state(schedule(), {
      skipOwnerlessScheduleAndAudit: async () => {
        current.schedules.get("nightly")!.principalId = "new-owner";
        return false;
      },
    });

    await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
    expect(current.schedules.get("nightly")).toMatchObject({
      principalId: "new-owner",
      nextRunAt: NOW,
      lastRunAt: null,
    });
    expect(current.auditLogs).toHaveLength(0);
  });

  it("continues evaluating later schedules when an atomic skip cannot be persisted", async () => {
    const current = state(schedule(), {
      skipOwnerlessScheduleAndAudit: async () => {
        throw new Error("audit unavailable");
      },
    });
    current.schedules.set("owned", schedule({ id: "owned", principalId: "principal" }));

    await expect(evaluateCronDurable(current, NOW)).resolves.toMatchObject([{ id: "run" }]);
    expect(current.schedules.get("nightly")).toMatchObject({ nextRunAt: NOW, lastRunAt: null });
  });
});
