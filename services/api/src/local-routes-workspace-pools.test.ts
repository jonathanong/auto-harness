import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleWorkspacePoolRoutes } from "./local-routes-workspace-pools.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

function invoke(plane: ControlPlane, method: string, path: string, body?: unknown) {
  return invokeHandler(createLocalApp({ plane }).handler, method, path, body);
}

describe("workspace-pool routes", () => {
  it("creates, reads, updates, and deletes an admin pool", async () => {
    const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool-1" });
    const body = {
      name: "browser-tests",
      setupProfiles: [{ id: "install", name: "Install", script: "pnpm install" }],
      defaultSetupProfileId: "install",
      destroyWorkspaceAfter: true,
    };
    expect((await invoke(plane, "POST", "/api/v1/workspace-pools", body)).status).toBe(201);
    expect((await invoke(plane, "GET", "/api/v1/workspace-pools")).json).toMatchObject({
      items: [{ id: "pool-1", setupProfiles: [{ id: "install", name: "Install" }] }],
    });
    expect((await invoke(plane, "GET", "/api/v1/workspace-pools/pool-1")).json).toMatchObject({
      id: "pool-1",
      setupProfiles: [{ id: "install", name: "Install" }],
    });
    expect(
      (await invoke(plane, "GET", "/api/v1/workspace-pools/pool-1/exec-config")).json,
    ).toMatchObject({ setupProfiles: [{ script: "pnpm install" }] });
    expect(
      (
        await invoke(plane, "PATCH", "/api/v1/workspace-pools/pool-1", {
          name: "browser-tests-renamed",
          defaultSetupProfileId: null,
        })
      ).status,
    ).toBe(200);
    expect((await invoke(plane, "DELETE", "/api/v1/workspace-pools/pool-1")).status).toBe(204);
    expect((await invoke(plane, "GET", "/api/v1/workspace-pools/pool-1")).status).toBe(404);
  });

  it("maps validation, missing resources, and scoped access to safe responses", async () => {
    const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool-1" });
    expect((await invoke(plane, "POST", "/api/v1/workspace-pools", {})).status).toBe(400);
    expect((await invoke(plane, "PUT", "/api/v1/workspace-pools/missing", {})).status).toBe(404);
    expect((await invoke(plane, "GET", "/api/v1/workspace-pools/missing/exec-config")).status).toBe(
      404,
    );
    const principal: Principal = {
      id: "scoped",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["repo"],
    };
    const response = await invokeHandler(
      (req, res) =>
        handleWorkspacePoolRoutes({
          plane,
          req,
          res,
          url: new URL("/api/v1/workspace-pools", "http://localhost"),
          method: "GET",
          principal,
        }),
      "GET",
      "/api/v1/workspace-pools",
    );
    expect(response.status).toBe(404);
  });
});
