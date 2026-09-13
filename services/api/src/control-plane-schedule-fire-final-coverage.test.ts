import { describe, expect, it, vi } from "vitest";

import { setInMemoryScheduleStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import {
  tryClaimScheduleFire,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";
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

function state(row: ScheduleRecord) {
  const current = createControlPlaneState({ idFactory: () => "run", now: () => NOW });
  current.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  current.schedules.set(row.id, row);
  return current;
}

describe("schedule fire final branch coverage", () => {
  it("consumes a pre-activation occurrence through the closed-repository CAS", async () => {
    const expectedNextRunAt = "2026-01-01T00:01:00.000Z";
    const current = state(schedule({ nextRunAt: expectedNextRunAt }));
    current.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "https://example.test/repo",
      defaultBranch: "main",
      admissionState: "paused",
      admissionStateChangedAt: NOW,
      activationCutoffAt: "2026-01-01T00:02:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const skippedBeforeCutoff = vi.fn(async () => true);
    const skippedWhileClosed = vi.fn(async () => true);
    setInMemoryScheduleStorage(current, {
      skipScheduleBeforeActivationCutoff: skippedBeforeCutoff,
      skipScheduleForClosedRepository: skippedWhileClosed,
    });

    await expect(
      tryClaimScheduleFireDurable(
        current,
        "nightly",
        expectedNextRunAt,
        "2026-01-01T00:03:00.000Z",
      ),
    ).resolves.toBeNull();

    expect(skippedBeforeCutoff).not.toHaveBeenCalled();
    expect(skippedWhileClosed).toHaveBeenCalledOnce();
    expect(current.schedules.get("nightly")?.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
  });

  it("creates an ownerless workspace run with the persisted false cleanup default", () => {
    const current = state(
      schedule({
        repositoryId: "",
        principalId: undefined,
        workspacePoolId: "pool",
        destroyWorkspaceAfter: undefined,
      }),
    );
    current.workspacePools.set("pool", {
      id: "pool",
      name: "pool",
      setupProfiles: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const created = tryClaimScheduleFire(current, "nightly", NOW, NOW);

    expect(created).toMatchObject({
      id: "run",
      type: "workspace",
      destroyWorkspaceAfter: false,
    });
    expect(created).not.toHaveProperty("principalId");
  });

  it("uses false when a durable workspace schedule and its pool omit cleanup policy", async () => {
    const current = state(
      schedule({
        repositoryId: "",
        workspacePoolId: "pool",
        destroyWorkspaceAfter: undefined,
      }),
    );
    current.workspacePools.set("pool", {
      id: "pool",
      name: "pool",
      setupProfiles: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    setInMemoryScheduleStorage(current, {
      getWorkspacePool: async (id: string) => current.workspacePools.get(id) ?? null,
    });

    await expect(tryClaimScheduleFireDurable(current, "nightly", NOW, NOW)).resolves.toMatchObject({
      id: "run",
      type: "workspace",
      destroyWorkspaceAfter: false,
    });
    expect(current.sessions.get("run")).toMatchObject({
      destroyWorkspaceAfter: false,
      principalId: "principal",
    });
  });
});
