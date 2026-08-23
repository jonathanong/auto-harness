import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function invoke(plane: ControlPlane, path: string) {
  return invokeHandler(createLocalApp({ plane }).handler, "POST", path, {});
}

function seededPlane(): ControlPlane {
  const plane = new ControlPlane({ now: () => NOW });
  plane.state.repositories.set("repository", {
    id: "repository",
    name: "repository",
    url: "/repository",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });
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
  return plane;
}

describe("repository admission routes", () => {
  it("operates admission and returns stable conflicts", async () => {
    const plane = seededPlane();
    expect(await invoke(plane, "/api/v1/repositories/missing/pause")).toMatchObject({
      status: 404,
      json: { error: { code: "NOT_FOUND" } },
    });
    expect(await invoke(plane, "/api/v1/repositories/repository/pause")).toMatchObject({
      status: 200,
      json: { admissionState: "paused" },
    });
    expect(await invoke(plane, "/api/v1/schedules/schedule/trigger")).toMatchObject({
      status: 409,
      json: { error: { code: "REPOSITORY_ADMISSION_CLOSED" } },
    });
    expect(await invoke(plane, "/api/v1/repositories/repository/activate")).toMatchObject({
      status: 200,
      json: { admissionState: "active" },
    });
    expect(await invoke(plane, "/api/v1/repositories/repository/drain")).toMatchObject({
      status: 200,
      json: { admissionState: "paused" },
    });
    plane.state.repositories.get("repository")!.admissionState = "draining";
    expect(await invoke(plane, "/api/v1/repositories/repository/activate")).toMatchObject({
      status: 409,
      json: { error: { code: "CONFLICT" } },
    });
  });
});
