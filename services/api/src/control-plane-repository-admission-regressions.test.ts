import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("repository admission regressions", () => {
  it("catches a schedule that becomes due during activation scanning", async () => {
    let activation = false;
    let activationCalls = 0;
    const plane = new ControlPlane({
      now: () => {
        if (!activation) return "2026-01-01T00:00:00.000Z";
        activationCalls += 1;
        return activationCalls === 1 ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:02:00.000Z";
      },
    });
    seedBaseCommand(plane);
    plane.createRepository({ id: "repo-1", name: "repo", url: "url" });
    await plane.pauseRepositoryDurable("repo-1");
    expect(
      plane.putSchedule({
        id: "schedule-1",
        repositoryId: "repo-1",
        name: "schedule",
        target: { commandId: "cmd-base" },
        cron: "* * * * *",
        timeout: 30,
      }).ok,
    ).toBe(true);
    activation = true;

    await expect(plane.activateRepositoryDurable("repo-1")).resolves.toMatchObject({ ok: true });
    expect(plane.getSchedule("schedule-1")?.nextRunAt).toBe("2026-01-01T00:03:00.000Z");
  });

  it("clears a completed timestamp when an in-memory drain is reopened", async () => {
    const plane = new ControlPlane();
    plane.createRepository({ id: "repo-1", name: "repo", url: "url" });
    await expect(plane.drainRepositoryDurable("repo-1")).resolves.toMatchObject({
      ok: true,
      repository: { admissionState: "paused", drainCompletedAt: expect.any(String) },
    });
    plane.state.mainCheckoutLeases.set("host-1\0repo-1", {
      sessionId: "session-1",
      connectionId: "connection-1",
    });

    await expect(plane.drainRepositoryDurable("repo-1")).resolves.toMatchObject({
      ok: true,
      repository: { admissionState: "draining" },
    });
    expect(plane.state.repositories.get("repo-1")).not.toHaveProperty("drainCompletedAt");
  });
});
