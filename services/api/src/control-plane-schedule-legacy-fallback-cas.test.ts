import { MAX_FALLBACKS } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { setInMemoryScheduleStorage } from "./control-plane-durable-read-test-helpers.ts";
import { triggerScheduleDurable } from "./control-plane-schedule-fire.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("legacy schedule fallback disable CAS", () => {
  it("reports a lost CAS without changing the cached schedule", async () => {
    const state = createControlPlaneState({ idFactory: () => "run", now: () => NOW });
    state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "https://example.test/repo",
      defaultBranch: "main",
      admissionState: "active",
      admissionStateChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.commands.set("cmd", {
      id: "cmd",
      name: "cmd",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
    });
    state.schedules.set("nightly", {
      id: "nightly",
      repositoryId: "repo",
      principalId: "principal",
      name: "nightly",
      target: { commandId: "cmd" },
      fallbacks: Array.from({ length: MAX_FALLBACKS + 1 }, () => ({ commandId: "cmd" })),
      targetLabels: ["cmd"],
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      queueTtlSeconds: 3600,
      nextRunAt: NOW,
      lastRunAt: null,
      createdAt: NOW,
    });
    setInMemoryScheduleStorage(state, {
      tryClaimScheduleAndCreateSession: async () => ({
        kind: "legacy_fallbacks",
        fallbackCount: MAX_FALLBACKS + 1,
      }),
      disableLegacyFallbackScheduleAndAudit: async () => false,
    });

    await expect(triggerScheduleDurable(state, "nightly", NOW)).resolves.toEqual({
      ok: false,
      error: "schedule changed concurrently; legacy fallback disable was not applied",
    });
    expect(state.schedules.get("nightly")).toMatchObject({ enabled: true });
    expect(state.auditLogs).toHaveLength(0);
  });
});
