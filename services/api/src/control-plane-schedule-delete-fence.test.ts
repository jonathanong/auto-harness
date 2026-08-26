import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable schedule deletion fencing", () => {
  it("serializes owned schedule deletion with the principal deletion fence", async () => {
    const schedule = {
      id: "schedule",
      repositoryId: "repository",
      principalId: "principal",
      name: "schedule",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      queueTtlSeconds: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let markerAvailable = false;
    let deleted = false;
    const storage = {
      getSchedule: async () => ({ ...schedule }),
      acquireDeletionMarker: async () => markerAvailable,
      releaseDeletionMarker: async () => undefined,
      deleteSchedule: async () => {
        deleted = true;
      },
    };
    const plane = new ControlPlane({ storage: storage as never });

    await expect(plane.deleteScheduleDurable(schedule.id)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(deleted).toBe(false);

    markerAvailable = true;
    await expect(plane.deleteScheduleDurable(schedule.id)).resolves.toEqual({ ok: true });
    expect(deleted).toBe(true);
  });

  it("reports a lost deletion lease without evicting the cached schedule", async () => {
    const schedule = {
      id: "schedule",
      repositoryId: "repository",
      principalId: "principal",
      name: "schedule",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      queueTtlSeconds: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const plane = new ControlPlane({
      storage: {
        getSchedule: async () => ({ ...schedule }),
        acquireDeletionMarker: async () => true,
        releaseDeletionMarker: async () => undefined,
        deleteSchedule: async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          };
        },
      } as never,
    });

    await expect(plane.deleteScheduleDurable(schedule.id)).resolves.toEqual({
      ok: false,
      conflict: true,
      error: "catalog deletion lease was lost; retry the request",
    });
    expect(plane.state.schedules.get(schedule.id)).toMatchObject(schedule);
  });
});
