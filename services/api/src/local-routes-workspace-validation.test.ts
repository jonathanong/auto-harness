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
    plane,
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

  it("allows cleanup overrides when authentication is disabled", async () => {
    const { invoke } = workspaceRoutes();
    expect(
      await invoke("POST", "/api/v1/schedules", { ...schedule, destroyWorkspaceAfter: true }),
    ).toMatchObject({ status: 201, json: { destroyWorkspaceAfter: true } });
  });

  it("validates workspace fields while patching an existing schedule", async () => {
    const { invoke, plane } = workspaceRoutes();
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
    ).toMatchObject({ status: 200, json: { destroyWorkspaceAfter: true } });
    expect(
      await invoke("PATCH", "/api/v1/schedules/schedule-1", {
        setupProfileId: null,
        destroyWorkspaceAfter: null,
      }),
    ).toMatchObject({ status: 200, json: { destroyWorkspaceAfter: false } });
    expect(plane.getSchedule("schedule-1")).not.toHaveProperty("setupProfileId");
  });

  it("drops an inherited repository ref when converting a schedule to a workspace", async () => {
    const { invoke, plane } = workspaceRoutes();
    expect(
      plane.createRepository({
        id: "repository-1",
        name: "repository",
        url: "https://example.test/repository.git",
      }).ok,
    ).toBe(true);
    expect(
      (
        await invoke("POST", "/api/v1/schedules", {
          ...schedule,
          repositoryId: "repository-1",
          workspacePoolId: undefined,
          ref: "main",
        })
      ).status,
    ).toBe(201);

    expect(
      await invoke("PATCH", "/api/v1/schedules/schedule-1", {
        repositoryId: null,
        workspacePoolId: "pool-1",
      }),
    ).toMatchObject({ status: 200, json: { repositoryId: null, workspacePoolId: "pool-1" } });
    expect(plane.getSchedule("schedule-1")).not.toHaveProperty("ref");
  });

  it("rejects an explicit repository ref while converting to a workspace schedule", async () => {
    const { invoke, plane } = workspaceRoutes();
    expect(
      plane.createRepository({
        id: "repository-1",
        name: "repository",
        url: "https://example.test/repository.git",
      }).ok,
    ).toBe(true);
    expect(
      (
        await invoke("POST", "/api/v1/schedules", {
          ...schedule,
          repositoryId: "repository-1",
          workspacePoolId: undefined,
          ref: "main",
        })
      ).status,
    ).toBe(201);

    expect(
      await invoke("PATCH", "/api/v1/schedules/schedule-1", {
        repositoryId: null,
        workspacePoolId: "pool-1",
        ref: "another-branch",
      }),
    ).toMatchObject({
      status: 400,
      json: { error: { message: "ref is not supported for workspace schedules" } },
    });
    expect(plane.getSchedule("schedule-1")).toMatchObject({
      repositoryId: "repository-1",
      ref: "main",
    });
  });
});
