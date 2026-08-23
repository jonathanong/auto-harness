import { describe, expect, it } from "vitest";

import { seedBaseCommand } from "./control-plane-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

describe("schedule repository admission", () => {
  it("rejects local durable schedule creation while admission is closed", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:05:00.000Z" });
    seedBaseCommand(plane);
    plane.createRepository({ id: "repo-1", name: "repo", url: "url" });
    await plane.pauseRepositoryDurable("repo-1");

    await expect(
      plane.putScheduleDurable({
        id: "schedule-1",
        repositoryId: "repo-1",
        name: "schedule",
        target: { commandId: "cmd-base" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).resolves.toEqual({ ok: false, error: "repository admission is paused" });
    expect(plane.getSchedule("schedule-1")).toBeNull();
  });
});
