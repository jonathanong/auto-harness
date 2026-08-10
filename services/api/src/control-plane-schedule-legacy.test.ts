import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("legacy schedule concurrency", () => {
  it("enriches a hydrated legacy schedule with its generated id and active session", async () => {
    const plane = new ControlPlane();
    const legacy = {
      id: "legacy",
      repositoryId: "repo-1",
      name: "legacy",
      commandId: "cmd-base",
      targetLabel: "local",
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      nextRunAt: "2030-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const active = {
      id: "legacy-active",
      repositoryId: "repo-1",
      prompt: "scheduled:legacy",
      targetLabel: "local",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      concurrencyId: "schedule-legacy",
    };
    plane.state.storage = new Proxy(
      {
        listAllSessions: async () => [active],
        listSchedules: async () => [legacy],
      },
      {
        get(target, property) {
          return property in target ? target[property as keyof typeof target] : async () => [];
        },
      },
    ) as never;
    await plane.hydrateFromStorage();
    expect(plane.getSchedule("legacy")).toMatchObject({
      concurrencyId: "schedule-legacy",
      activeSessionId: "legacy-active",
    });
  });
});
