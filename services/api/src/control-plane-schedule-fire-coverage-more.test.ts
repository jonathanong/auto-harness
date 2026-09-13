import { describe, expect, it } from "vitest";

import { setInMemoryScheduleStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { tryClaimScheduleFireDurable } from "./control-plane-schedule-fire.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { ScheduleRecord } from "./control-plane-types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "nightly",
    repositoryId: "repo",
    principalId: "principal",
    name: "nightly",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
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

function state(row: ScheduleRecord, storage: Record<string, unknown>) {
  const current = createControlPlaneState({ idFactory: () => "run", now: () => NOW });
  current.repositories.set("repo", {
    id: "repo",
    name: "repo",
    url: "https://example.test/repo",
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
  setInMemoryScheduleStorage(current, storage);
  return current;
}

describe("schedule fire CAS residual branches", () => {
  it("handles duplicate sessions whether the active-concurrency cursor skip wins or loses", async () => {
    for (const skipped of [false, true]) {
      const current = state(schedule({ concurrencyId: "shared" }), {
        tryClaimScheduleAndCreateSession: async () => ({
          kind: "duplicate",
          session: {
            id: "existing",
            repositoryId: "repo",
            type: "command",
            status: "queued",
            createdAt: NOW,
            updatedAt: NOW,
            commandId: "cmd",
            target: { commandId: "cmd" },
            prompt: "",
            timeout: 30,
            scheduleId: "nightly",
          },
        }),
        skipScheduleForActiveConcurrency: async () => skipped,
      });
      await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
      expect(current.sessions.has("existing")).toBe(skipped);
      expect(current.schedules.get("nightly")?.nextRunAt).toBe(
        skipped ? "2026-01-01T00:01:00.000Z" : NOW,
      );
    }
  });

  it("handles principal-drain audit CAS outcomes without creating a session", async () => {
    for (const skipped of [false, true]) {
      const current = state(schedule(), {
        tryClaimScheduleAndCreateSession: async () => ({
          kind: "draining",
          operationId: "drain-1",
        }),
        skipScheduleForPrincipalDrainAndAudit: async () => skipped,
      });
      await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
      expect(current.auditLogs.size).toBe(skipped ? 1 : 0);
      expect(current.schedules.get("nightly")?.nextRunAt).toBe(
        skipped ? "2026-01-01T00:01:00.000Z" : NOW,
      );
    }
  });

  it("keeps a fallback-heavy schedule enabled when disable audit loses its CAS", async () => {
    const current = state(
      schedule({ fallbacks: Array.from({ length: 91 }, () => ({ commandId: "cmd" })) }),
      {
        tryClaimScheduleAndCreateSession: async () => ({
          kind: "legacy_fallbacks",
          fallbackCount: 91,
        }),
        disableLegacyFallbackScheduleAndAudit: async () => false,
      },
    );
    await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toBeNull();
    expect(current.schedules.get("nightly")?.enabled).toBe(true);
  });
});
