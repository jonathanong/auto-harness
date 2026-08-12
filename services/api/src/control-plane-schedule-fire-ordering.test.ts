import { describe, expect, it } from "vitest";

import { queueWrite, settleStorage } from "./control-plane-state.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

describe("queued schedule fire writes", () => {
  it("snapshots a queued cursor before the cached record mutates", async () => {
    const plane = new ControlPlane({ idFactory: () => "session-1" });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "queued-cursors",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    const persisted: Array<{ lastRunAt?: string; nextRunAt: string }> = [];
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    plane.state.storage = {
      putSchedule: async (record: { lastRunAt?: string; nextRunAt: string }) => {
        persisted.push({ lastRunAt: record.lastRunAt, nextRunAt: record.nextRunAt });
      },
      putSession: async () => undefined,
    } as never;
    queueWrite(plane.state, async () => firstDone);

    expect(plane.triggerSchedule(schedule.id, "2026-01-01T00:00:00.000Z")).toMatchObject({
      ok: true,
      created: true,
    });
    const cached = plane.state.schedules.get(schedule.id)!;
    cached.lastRunAt = "2026-01-01T00:05:00.000Z";
    cached.nextRunAt = "2026-01-01T00:06:00.000Z";
    releaseFirst?.();
    await settleStorage(plane.state);

    expect(persisted).toEqual([
      {
        lastRunAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-01T00:01:00.000Z",
      },
    ]);
  });
});
