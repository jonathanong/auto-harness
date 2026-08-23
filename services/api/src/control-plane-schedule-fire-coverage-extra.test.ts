/* eslint-disable max-lines -- schedule-fire coverage cases share one fixture. */
import { MAX_FALLBACKS } from "@auto-harness/shared";
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

  it("fences a durable manual trigger to the current activation generation", async () => {
    let observedCutoff: string | undefined;
    const current = state(schedule({ principalId: "principal" }), {
      tryClaimScheduleAndCreateSession: async (opts: { activationCutoffAt?: string }) => {
        observedCutoff = opts.activationCutoffAt;
        return { kind: "created" };
      },
    });
    current.repositories.get("repo")!.activationCutoffAt = "2026-01-01T00:02:00.000Z";

    await expect(triggerScheduleDurable(current, "nightly")).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    expect(observedCutoff).toBe("2026-01-01T00:02:00.000Z");
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

  it("fences a stale due occurrence at the repository activation cutoff", async () => {
    let skipped = 0;
    let claimed = 0;
    const current = state(
      schedule({
        principalId: "principal",
        nextRunAt: "2026-01-01T00:01:00.000Z",
      }),
      {
        tryClaimScheduleAndCreateSession: async () => {
          claimed += 1;
          return { kind: "created" };
        },
        skipScheduleBeforeActivationCutoff: async () => {
          skipped += 1;
          return true;
        },
      },
    );
    current.repositories.get("repo")!.activationCutoffAt = "2026-01-01T00:02:00.000Z";

    await expect(
      tryClaimScheduleFireDurable(
        current,
        "nightly",
        "2026-01-01T00:01:00.000Z",
        "2026-01-01T00:03:00.000Z",
      ),
    ).resolves.toBeNull();
    expect(skipped).toBe(1);
    expect(claimed).toBe(0);
    expect(current.schedules.get("nightly")).toMatchObject({
      nextRunAt: "2026-01-01T00:04:00.000Z",
    });
    expect(current.sessions).toHaveLength(0);
  });

  it("claims a legacy offset cursor using numeric cutoff ordering", async () => {
    let claim: { activationCutoffAt?: string; expectedNextRunAtEpochMs?: number } | undefined;
    const cursor = "2026-01-01T01:45:00+01:00";
    const current = state(schedule({ principalId: "principal", nextRunAt: cursor }), {
      tryClaimScheduleAndCreateSession: async (opts: {
        activationCutoffAt?: string;
        expectedNextRunAtEpochMs?: number;
      }) => {
        claim = opts;
        return { kind: "created" };
      },
    });
    current.repositories.get("repo")!.activationCutoffAt = "2026-01-01T00:30:00.000Z";

    await expect(
      tryClaimScheduleFireDurable(current, "nightly", cursor, "2026-01-01T01:00:00.000Z"),
    ).resolves.toMatchObject({ id: "run" });
    expect(claim).toMatchObject({
      activationCutoffAt: "2026-01-01T00:30:00.000Z",
      expectedNextRunAtEpochMs: Date.parse(cursor),
    });
  });

  it("leaves a stale cutoff occurrence for a concurrent close and reopen", async () => {
    let observedCutoff: string | undefined;
    const current = state(
      schedule({
        principalId: "principal",
        nextRunAt: "2026-01-01T00:01:00.000Z",
      }),
      {
        tryClaimScheduleAndCreateSession: async () => ({ kind: "created" }),
        skipScheduleBeforeActivationCutoff: async ({
          activationCutoffAt,
        }: {
          activationCutoffAt: string;
        }) => {
          observedCutoff = activationCutoffAt;
          current.repositories.get("repo")!.activationCutoffAt = "2026-01-01T00:04:00.000Z";
          return false;
        },
      },
    );
    current.repositories.get("repo")!.activationCutoffAt = "2026-01-01T00:02:00.000Z";

    await expect(
      tryClaimScheduleFireDurable(
        current,
        "nightly",
        "2026-01-01T00:01:00.000Z",
        "2026-01-01T00:03:00.000Z",
      ),
    ).resolves.toBeNull();
    expect(observedCutoff).toBe("2026-01-01T00:02:00.000Z");
    expect(current.schedules.get("nightly")).toMatchObject({
      nextRunAt: "2026-01-01T00:01:00.000Z",
    });
    expect(current.sessions).toHaveLength(0);
  });

  it("consumes a stale cutoff cursor through the closed-repository CAS", async () => {
    let cutoffSkips = 0;
    const current = state(
      schedule({ principalId: "principal", nextRunAt: "2026-01-01T00:01:00.000Z" }),
      {
        skipScheduleBeforeActivationCutoff: async () => {
          cutoffSkips += 1;
          current.repositories.get("repo")!.admissionState = "paused";
          return false;
        },
      },
    );
    Object.assign(current.repositories.get("repo")!, {
      activationCutoffAt: "2026-01-01T00:02:00.000Z",
    });

    await expect(
      tryClaimScheduleFireDurable(
        current,
        "nightly",
        "2026-01-01T00:01:00.000Z",
        "2026-01-01T00:03:00.000Z",
      ),
    ).resolves.toBeNull();
    expect(cutoffSkips).toBe(1);
    expect(current.schedules.get("nightly")?.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
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

  it("explicitly disables and audits legacy fallback-heavy cron schedules", async () => {
    const current = state(
      schedule({
        principalId: "principal",
        fallbacks: Array.from({ length: 91 }, () => ({ commandId: "cmd" })),
      }),
      {
        tryClaimScheduleAndCreateSession: async () => ({
          kind: "legacy_fallbacks",
          fallbackCount: 91,
        }),
        disableLegacyFallbackScheduleAndAudit: async () => true,
      },
    );

    await expect(evaluateCronDurable(current, NOW)).resolves.toEqual([]);
    expect(current.schedules.get("nightly")).toMatchObject({ enabled: false });
    expect([...current.auditLogs.values()]).toContainEqual(
      expect.objectContaining({
        action: "schedule:legacy-fallbacks-disabled",
        resourceType: "schedule",
        resourceId: "nightly",
        outcome: "failed",
        metadata: expect.objectContaining({ fallbackCount: 91, maxFallbacks: MAX_FALLBACKS }),
      }),
    );
  });

  it("explicitly disables a legacy fallback-heavy manual trigger", async () => {
    const current = state(
      schedule({
        principalId: "principal",
        fallbacks: Array.from({ length: 91 }, () => ({ commandId: "cmd" })),
      }),
      {
        tryClaimScheduleAndCreateSession: async () => ({
          kind: "legacy_fallbacks",
          fallbackCount: 91,
        }),
        disableLegacyFallbackScheduleAndAudit: async () => true,
      },
    );

    await expect(triggerScheduleDurable(current, "nightly", NOW)).resolves.toEqual({
      ok: false,
      error: `schedule disabled: it has 91 persisted fallbacks; update it to at most ${MAX_FALLBACKS}`,
    });
    expect(current.schedules.get("nightly")).toMatchObject({ enabled: false });
  });
});
