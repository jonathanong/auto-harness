import { describe, expect, it } from "vitest";

import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function schedulePlane(storage: object): ControlPlane {
  const plane = new ControlPlane({ storage: storage as never, now: () => NOW });
  plane.state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  plane.state.schedules.set("schedule", {
    id: "schedule",
    repositoryId: "repository",
    name: "schedule",
    target: { commandId: "command" },
    fallbacks: [],
    targetLabels: ["command"],
    cron: "* * * * *",
    enabled: true,
    timeout: 60,
    queueTtlSeconds: 3600,
    nextRunAt: "2026-01-01T00:01:00.000Z",
    lastRunAt: null,
    createdAt: NOW,
    concurrencyId: "schedule-schedule",
  });
  addDurableReadDefaults(plane.state);
  return plane;
}

describe("durable schedule management conflicts", () => {
  it("returns schedule validation failures before attempting a cursor write", async () => {
    const plane = schedulePlane({ updateScheduleManagement: async () => null });
    await expect(plane.updateScheduleDurable("schedule", { ref: "bad ref" })).resolves.toEqual({
      ok: false,
      error: "ref must be a valid scheduled branch name",
    });
  });

  it("returns a bounded conflict after three lost cursor comparisons", async () => {
    let attempts = 0;
    const plane = schedulePlane({
      updateScheduleManagement: async () => {
        attempts++;
        return null;
      },
    });

    await expect(plane.updateScheduleDurable("schedule", { name: "changed" })).resolves.toEqual({
      ok: false,
      error: "schedule changed concurrently; retry",
    });
    expect(attempts).toBe(3);
    expect(plane.getSchedule("schedule")?.name).toBe("schedule");
  });

  it("evicts a schedule deleted after a lost cursor comparison", async () => {
    let reads = 0;
    const plane = schedulePlane({
      updateScheduleManagement: async () => null,
      getSchedule: async () => {
        reads++;
        return reads === 1
          ? {
              id: "schedule",
              repositoryId: "repository",
              name: "schedule",
              target: { commandId: "command" },
              fallbacks: [],
              targetLabels: ["command"],
              cron: "* * * * *",
              enabled: true,
              timeout: 60,
              queueTtlSeconds: 3600,
              nextRunAt: "2026-01-01T00:01:00.000Z",
              lastRunAt: null,
              createdAt: NOW,
              concurrencyId: "schedule-schedule",
            }
          : null;
      },
    });

    await expect(plane.updateScheduleDurable("schedule", { name: "changed" })).resolves.toEqual({
      ok: false,
      error: "schedule not found",
    });
    expect(plane.getSchedule("schedule")).toBeNull();
  });
});
