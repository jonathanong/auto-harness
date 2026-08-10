import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("scheduled assignment rollout", () => {
  it("keeps scheduled sessions out of the worktree assignment path", () => {
    const plane = new ControlPlane({ idFactory: () => "scheduled-session", shardCount: 1 });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "maintenance",
      commandId: "cmd-base",
      cron: "* * * * *",
      timeout: 30,
      nextRunAt: "t",
      ref: "main",
    });
    plane.registerHost({
      hostId: "host-1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/wt-1", labels: [] }],
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
    });

    expect(plane.triggerSchedule(schedule.id).ok).toBe(true);
    expect(plane.assignQueued()).toEqual([]);
    expect(plane.getSession("scheduled-session")?.status).toBe("queued");
    expect(plane.listWorktrees()[0]).toMatchObject({ id: "wt-1", status: "idle" });
  });
});
