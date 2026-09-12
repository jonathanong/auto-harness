import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

function workspaceRoutes() {
  const plane = new ControlPlane({
    workspacePoolIdFactory: () => "pool-1",
    scheduleIdFactory: () => "schedule-1",
  });
  plane.createCommand({ id: "command-1", name: "echo", argv: ["echo"], providerId: null });
  expect(plane.createWorkspacePool({ name: "pool" }).ok).toBe(true);
  const { handler } = createLocalApp({ plane, rateLimitConfig: { enabled: false } });
  return {
    invoke: (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body),
  };
}

const schedule = {
  repositoryId: null,
  workspacePoolId: "pool-1",
  name: "workspace schedule",
  target: { commandId: "command-1" },
  cron: "* * * * *",
  timeout: 30,
};

describe("workspace schedule route validation", () => {
  it.each([
    [{ ...schedule, workspacePoolId: "" }, "workspacePoolId is required for workspace schedules"],
    [{ ...schedule, ref: "main" }, "ref is not supported for workspace schedules"],
    [{ ...schedule, requiredLabels: "gpu" }, "requiredLabels must be an array"],
    [
      { ...schedule, requiredLabels: ["gpu"] },
      "requiredLabels are not supported for workspace schedules",
    ],
    [{ ...schedule, setupProfileId: "" }, "setupProfileId must be a non-empty string"],
    [{ ...schedule, setupProfileId: 3 }, "setupProfileId must be a non-empty string"],
    [{ ...schedule, destroyWorkspaceAfter: "yes" }, "destroyWorkspaceAfter must be a boolean"],
  ])("rejects invalid workspace fields", async (body, message) => {
    const { invoke } = workspaceRoutes();
    expect(await invoke("POST", "/api/v1/schedules", body)).toMatchObject({
      status: 400,
      json: { error: { message } },
    });
  });

  it("requires the privileged capability for cleanup overrides", async () => {
    const { invoke } = workspaceRoutes();
    expect(
      await invoke("POST", "/api/v1/schedules", { ...schedule, destroyWorkspaceAfter: true }),
    ).toMatchObject({
      status: 403,
      json: { error: { message: "fleet:exec-config capability is required" } },
    });
  });

  it("validates workspace fields while patching an existing schedule", async () => {
    const { invoke } = workspaceRoutes();
    expect((await invoke("POST", "/api/v1/schedules", schedule)).status).toBe(201);
    expect(
      await invoke("PATCH", "/api/v1/schedules/schedule-1", { repositoryId: { id: "repo" } }),
    ).toMatchObject({
      status: 400,
      json: { error: { message: "repositoryId must be a string or null" } },
    });
    expect(
      await invoke("PATCH", "/api/v1/schedules/schedule-1", { requiredLabels: ["gpu"] }),
    ).toMatchObject({
      status: 400,
      json: { error: { message: "requiredLabels are not supported by schedule inputs" } },
    });
    expect(
      await invoke("PATCH", "/api/v1/schedules/schedule-1", { destroyWorkspaceAfter: true }),
    ).toMatchObject({
      status: 403,
      json: { error: { message: "fleet:exec-config capability is required" } },
    });
  });
});
