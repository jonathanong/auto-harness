import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import {
  evaluateCronDurable,
  triggerScheduleDurable,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { ScheduleRecord } from "./control-plane-types.ts";

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
  setDurableReadStorage(current, storage);
  return current;
}

describe("schedule fire residual coverage", () => {
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

  it("leaves an ownerless legacy schedule due until an authenticated update claims it", async () => {
    let claims = 0;
    const current = state(schedule(), {
      tryClaimScheduleAndCreateSession: async () => {
        claims += 1;
        return { kind: "created" };
      },
    });

    await expect(evaluateCronDurable(current, NOW)).resolves.toEqual([]);
    expect(claims).toBe(0);
    expect(current.schedules.get("nightly")?.nextRunAt).toBe(NOW);
  });
});
