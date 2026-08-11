import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("schedule cursor route contract", () => {
  it("derives omitted cursors and rejects non-string legacy cursor inputs", async () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      scheduleIdFactory: () => "schedule-1",
    });
    seedBaseCommand(plane);
    const { handler } = createLocalApp({ plane });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body);
    const schedule = {
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-base" },
      cron: "0 6 * * *",
      timeout: 60,
    };

    const created = await invoke("POST", "/api/v1/schedules", schedule);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ nextRunAt: "2026-01-01T06:00:00.000Z" });

    const invalidCreate = await invoke("POST", "/api/v1/schedules", {
      ...schedule,
      name: "invalid-create",
      nextRunAt: null,
    });
    expect(invalidCreate).toMatchObject({
      status: 400,
      json: { error: { message: "nextRunAt must be an ISO-8601 UTC timestamp" } },
    });

    const invalidUpdate = await invoke("PATCH", "/api/v1/schedules/schedule-1", {
      nextRunAt: { invalid: true },
    });
    expect(invalidUpdate).toMatchObject({
      status: 400,
      json: { error: { message: "nextRunAt must be an ISO-8601 UTC timestamp" } },
    });

    const updateWithoutCursor = await invoke("PATCH", "/api/v1/schedules/schedule-1", {
      name: "nightly-updated",
    });
    expect(updateWithoutCursor).toMatchObject({
      status: 200,
      json: { name: "nightly-updated", nextRunAt: "2026-01-01T06:00:00.000Z" },
    });
  });
});
