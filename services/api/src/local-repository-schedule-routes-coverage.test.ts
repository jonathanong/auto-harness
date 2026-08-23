import { describe, expect, it } from "vitest";

import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function invoke(plane: ControlPlane, method: string, path: string, body?: unknown) {
  return invokeHandler(createLocalApp({ plane }).handler, method, path, body);
}

function seededPlane(storage?: object): ControlPlane {
  const plane = new ControlPlane({ storage: storage as never, now: () => NOW });
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
  if (storage) addDurableReadDefaults(plane.state);
  return plane;
}

describe("repository and schedule route coverage", () => {
  it("validates typed schedule ref and cursor fields on create and update", async () => {
    const plane = seededPlane();
    const base = {
      repositoryId: "repository",
      name: "new-schedule",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 60,
    };
    for (const body of [
      { ...base, ref: 1 },
      { ...base, nextRunAt: 1 },
      { ...base, prompt: 1 },
    ]) {
      expect((await invoke(plane, "POST", "/api/v1/schedules", body)).status).toBe(400);
    }
    for (const body of [{ ref: 1 }, { nextRunAt: 1 }, { prompt: 1 }]) {
      expect((await invoke(plane, "PATCH", "/api/v1/schedules/schedule", body)).status).toBe(400);
    }
  });

  it("passes every optional repository and schedule field through the routes", async () => {
    const plane = seededPlane();
    expect((await invoke(plane, "POST", "/api/v1/repositories", {})).status).toBe(400);
    expect(
      (
        await invoke(plane, "POST", "/api/v1/repositories", {
          name: "second",
          url: "/second",
          defaultBranch: "trunk",
          setupScript: "setup",
          terminalHookScript: "hook",
        })
      ).status,
    ).toBe(201);
    expect((await invoke(plane, "PATCH", "/api/v1/repositories/second", {})).status).toBe(404);

    const created = await invoke(plane, "POST", "/api/v1/schedules", {
      id: "second-schedule",
      repositoryId: "repository",
      name: "second",
      target: { commandId: "command" },
      fallbacks: [],
      cron: "*/5 * * * *",
      timeout: 30,
      queueTtlSeconds: 120,
      nextRunAt: "2026-01-01T00:05:00.000Z",
      enabled: false,
      ref: "feature/test",
      concurrencyId: "group",
      prompt: "  review the repo  ",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ prompt: "review the repo" });
    const updated = await invoke(plane, "PATCH", "/api/v1/schedules/second-schedule", {
      repositoryId: "repository",
      name: "changed",
      target: { commandId: "command" },
      fallbacks: [],
      cron: "*/10 * * * *",
      timeout: 45,
      queueTtlSeconds: 180,
      nextRunAt: "2026-01-01T00:10:00.000Z",
      enabled: true,
      ref: "feature/changed",
      concurrencyId: "changed-group",
      prompt: "lint the tree",
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ prompt: "lint the tree" });
    const triggered = await invoke(plane, "POST", "/api/v1/schedules/second-schedule/trigger", {});
    expect(triggered).toMatchObject({
      status: 201,
      json: { prompt: "lint the tree", type: "scheduled", source: "schedule" },
    });
  });

  it("maps an otherwise valid trigger failure to TRIGGER_ERROR", async () => {
    const plane = seededPlane();
    plane.state.schedules.get("schedule")!.cron = "invalid";
    const response = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
    expect(response).toMatchObject({ status: 400, json: { error: { code: "TRIGGER_ERROR" } } });
  });

  it("returns an existing active scheduled session from a duplicate trigger", async () => {
    const plane = seededPlane();
    expect((await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {})).status).toBe(
      201,
    );
    const duplicate = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
    expect(duplicate).toMatchObject({ status: 200, json: { created: false } });
  });

  it("maps schedule write failures to internal errors", async () => {
    const create = seededPlane({
      putSchedule: async () => {
        throw new Error("write failed");
      },
    });
    expect(
      (
        await invoke(create, "POST", "/api/v1/schedules", {
          id: "new",
          repositoryId: "repository",
          name: "new",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 1,
        })
      ).status,
    ).toBe(500);

    const update = seededPlane({
      updateScheduleManagement: async () => {
        throw new Error("write failed");
      },
    });
    expect(
      (await invoke(update, "PATCH", "/api/v1/schedules/schedule", { name: "new" })).status,
    ).toBe(500);

    const remove = seededPlane({
      deleteSchedule: async () => {
        throw new Error("write failed");
      },
    });
    expect((await invoke(remove, "DELETE", "/api/v1/schedules/schedule")).status).toBe(500);
  });

  it("maps a durable trigger transaction failure to an internal error", async () => {
    const plane = seededPlane({
      tryClaimScheduleAndCreateSession: async () => {
        throw new Error("claim failed");
      },
    });
    plane.state.schedules.get("schedule")!.principalId = "principal";
    const response = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
    expect(response).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
  });
});
