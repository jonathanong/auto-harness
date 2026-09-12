import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";
import { setInMemoryScheduleStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";

it("rejects oversized workspace assignment frames before durable schedule persistence", async () => {
  for (const fire of ["manual", "cron"] as const) {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "session",
      scheduleIdFactory: () => "schedule",
    });
    seedBaseCommand(plane);
    expect(
      plane.createWorkspacePool({
        id: "pool",
        name: "workspace",
        setupProfiles: [{ id: "setup", name: "Setup", script: "small" }],
        defaultSetupProfileId: "setup",
      }).ok,
    ).toBe(true);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: null,
      workspacePoolId: "pool",
      name: "nightly",
      target: { commandId: "cmd-base" },
      prompt: "inspect",
      cron: "* * * * *",
      timeout: 30,
      principalId: "principal",
    });
    const oversizedPool = {
      ...plane.state.workspacePools.get("pool")!,
      setupProfiles: [{ id: "setup", name: "Setup", script: '"'.repeat(70_000) }],
    };
    const create = vi.fn();
    setInMemoryScheduleStorage(plane.state, {
      getWorkspacePool: async () => oversizedPool,
      tryClaimScheduleAndCreateSession: create,
    });
    plane.state.workspacePools.clear();

    const result =
      fire === "manual"
        ? await plane.triggerScheduleDurable(schedule.id, "2026-01-01T00:01:00.000Z")
        : await plane.tryClaimScheduleFireDurable(
            schedule.id,
            schedule.nextRunAt,
            "2026-01-01T00:01:00.000Z",
          );
    if (fire === "manual") {
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("assignment exceeds"),
      });
    } else {
      expect(result).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
    expect(plane.state.sessions.size).toBe(0);
    expect(plane.state.schedules.get(schedule.id)?.nextRunAt).toBe(schedule.nextRunAt);
  }
});
