import { describe, expect, it } from "vitest";

import {
  evaluateCronDurable,
  triggerScheduleDurable,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";
import { ControlPlane } from "./control-plane.ts";
import {
  BASE_COMMAND_ID,
  putScheduleOrThrow,
  seedBaseCommand,
} from "./control-plane-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function scheduledPlane(): ControlPlane {
  const plane = new ControlPlane({ idFactory: () => "scheduled-session", now: () => NOW });
  seedBaseCommand(plane);
  putScheduleOrThrow(plane, {
    id: "schedule",
    repositoryId: "repo",
    name: "nightly",
    target: { commandId: BASE_COMMAND_ID },
    cron: "* * * * *",
    timeout: 30,
    nextRunAt: NOW,
  });
  return plane;
}

describe("durable schedule claims", () => {
  it("keeps created, duplicate, and lost claims authoritative", async () => {
    const plane = scheduledPlane();
    const schedule = plane.state.schedules.get("schedule")!;
    const claimed: Array<Record<string, unknown>> = [];
    let outcome: "created" | "duplicate" | "lost" = "created";
    plane.state.storage = {
      tryClaimScheduleAndCreateSession: async (input: Record<string, unknown>) => {
        claimed.push(input);
        if (outcome === "created") return { kind: "created" };
        if (outcome === "lost") return { kind: "lost" };
        return {
          kind: "duplicate",
          session: {
            id: "existing",
            repositoryId: "repo",
            prompt: "scheduled:nightly",
            target: { commandId: BASE_COMMAND_ID },
            fallbacks: [],
            targetLabels: [BASE_COMMAND_ID],
            queueTtlSeconds: 3600,
            queueExpiresAt: "2026-01-01T01:00:00.000Z",
            timeout: 30,
            priority: 0,
            requiredLabels: [],
            onConflict: "queue",
            status: "queued",
            queueShard: 0,
            createdAt: NOW,
            type: "scheduled",
            source: "schedule",
            scheduleId: "schedule",
            concurrencyId: "schedule-schedule",
          },
        };
      },
      skipScheduleForActiveConcurrency: async () => true,
    } as never;

    await expect(triggerScheduleDurable(plane.state, "missing")).resolves.toEqual({
      ok: false,
      error: "schedule not found",
    });
    schedule.enabled = false;
    await expect(triggerScheduleDurable(plane.state, "schedule")).resolves.toEqual({
      ok: false,
      error: "schedule is disabled",
    });
    schedule.enabled = true;
    await expect(triggerScheduleDurable(plane.state, "schedule")).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    expect(claimed).toHaveLength(1);

    plane.state.schedules.set("schedule", { ...schedule, nextRunAt: NOW });
    outcome = "duplicate";
    await expect(plane.tryClaimScheduleFireDurable("schedule", NOW, NOW)).resolves.toBeNull();
    expect(plane.state.sessions.get("existing")).toMatchObject({
      id: "existing",
      scheduleId: "schedule",
    });

    plane.state.schedules.set("schedule", {
      ...plane.state.schedules.get("schedule")!,
      nextRunAt: NOW,
    });
    outcome = "lost";
    await expect(
      tryClaimScheduleFireDurable(plane.state, "schedule", NOW, NOW),
    ).resolves.toBeNull();
    await expect(
      tryClaimScheduleFireDurable(plane.state, "schedule", "wrong", NOW),
    ).resolves.toBeNull();
    plane.state.schedules.set("schedule", {
      ...plane.state.schedules.get("schedule")!,
      nextRunAt: "2026-01-01T00:01:00.000Z",
    });
    await expect(evaluateCronDurable(plane.state, NOW)).resolves.toEqual([]);
  });
});
