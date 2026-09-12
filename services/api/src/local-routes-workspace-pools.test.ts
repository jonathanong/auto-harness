/* eslint-disable max-lines -- each HTTP failure mapping needs a concrete public contract. */
import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleWorkspacePoolRoutes } from "./local-routes-workspace-pools.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

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

  it("does not acknowledge successful mutations when their audit write fails", async () => {
    const create = new ControlPlane({ workspacePoolIdFactory: () => "create-pool" });
    create.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (await invoke(create, "POST", "/api/v1/workspace-pools", { name: "created" })).status,
    ).toBe(500);

    const update = new ControlPlane({ workspacePoolIdFactory: () => "update-pool" });
    expect(
      (await invoke(update, "POST", "/api/v1/workspace-pools", { name: "before" })).status,
    ).toBe(201);
    update.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (await invoke(update, "PATCH", "/api/v1/workspace-pools/update-pool", { name: "after" }))
        .status,
    ).toBe(500);

    const remove = new ControlPlane({ workspacePoolIdFactory: () => "delete-pool" });
    expect(
      (await invoke(remove, "POST", "/api/v1/workspace-pools", { name: "to-delete" })).status,
    ).toBe(201);
    remove.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect((await invoke(remove, "DELETE", "/api/v1/workspace-pools/delete-pool")).status).toBe(
      500,
    );
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

  it.each([
    null,
    [],
    { name: 1 },
    { setupProfiles: {} },
    { setupProfiles: [null] },
    { setupProfiles: [{ id: "valid", name: 1, script: "echo ok" }] },
    { defaultSetupProfileId: 1 },
    { destroyWorkspaceAfter: "yes" },
  ])("rejects malformed pool input with a structured validation response", async (body) => {
    const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool-1" });
    expect(await invoke(plane, "POST", "/api/v1/workspace-pools", body)).toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR" } },
    });
  });

  it("does not expose pool configuration when durable reads or writes fail", async () => {
    const failure = new Error("storage unavailable");

    const list = new ControlPlane();
    list.listWorkspacePoolsDurable = async () => {
      throw failure;
    };
    expect((await invoke(list, "GET", "/api/v1/workspace-pools")).status).toBe(500);

    const create = new ControlPlane();
    create.createWorkspacePoolDurable = async () => {
      throw failure;
    };
    expect(
      (
        await invoke(create, "POST", "/api/v1/workspace-pools", {
          name: "pool",
          setupProfiles: [],
          destroyWorkspaceAfter: false,
        })
      ).status,
    ).toBe(500);

    const read = new ControlPlane();
    read.getWorkspacePoolDurable = async () => {
      throw failure;
    };
    expect((await invoke(read, "GET", "/api/v1/workspace-pools/pool/exec-config")).status).toBe(
      500,
    );

    const publicRead = new ControlPlane();
    publicRead.getWorkspacePoolPublicDurable = async () => {
      throw failure;
    };
    expect((await invoke(publicRead, "GET", "/api/v1/workspace-pools/pool")).status).toBe(500);

    const update = new ControlPlane();
    update.updateWorkspacePoolDurable = async () => {
      throw failure;
    };
    expect(
      (await invoke(update, "PATCH", "/api/v1/workspace-pools/pool", { name: "changed" })).status,
    ).toBe(500);

    const remove = new ControlPlane();
    remove.deleteWorkspacePoolDurable = async () => {
      throw failure;
    };
    expect((await invoke(remove, "DELETE", "/api/v1/workspace-pools/pool")).status).toBe(500);
  });

  it("leaves unsupported workspace-pool descendants for the next route", async () => {
    const response = await invoke(
      new ControlPlane(),
      "GET",
      "/api/v1/workspace-pools/pool/unsupported",
    );
    expect(response.status).toBe(404);
    expect((await invoke(new ControlPlane(), "POST", "/api/v1/workspace-pools/pool")).status).toBe(
      404,
    );

    const plane = new ControlPlane();
    let handled: boolean | undefined;
    await invokeHandler(
      async (req, res) => {
        handled = await handleWorkspacePoolRoutes({
          plane,
          req,
          res,
          url: new URL("/api/v1/not-workspace-pools", "http://localhost"),
          method: "GET",
        });
      },
      "GET",
      "/api/v1/not-workspace-pools",
    );
    expect(handled).toBe(false);
  });

  it("rejects malformed pool mutations before they reach the control plane", async () => {
    const { handler } = createLocalApp({ plane: new ControlPlane() });
    expect(await invokeBadJson(handler, "POST", "/api/v1/workspace-pools")).toBe(400);
    expect(await invokeBadJson(handler, "PATCH", "/api/v1/workspace-pools/pool")).toBe(400);
    expect(
      await invoke(new ControlPlane(), "PATCH", "/api/v1/workspace-pools/pool", { name: 42 }),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
  });

  it("accepts an empty partial update and leaves an unsupported collection method unhandled", async () => {
    expect(
      await invoke(new ControlPlane(), "PATCH", "/api/v1/workspace-pools/missing", {}),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect((await invoke(new ControlPlane(), "DELETE", "/api/v1/workspace-pools")).status).toBe(
      404,
    );
  });

  it("returns categorized errors when pool mutations lose their durable preconditions", async () => {
    for (const [error, status, code] of [
      ["workspace pool not found", 404, "NOT_FOUND"],
      ["workspace pool has active slots", 400, "VALIDATION_ERROR"],
    ] as const) {
      const plane = new ControlPlane();
      plane.updateWorkspacePoolDurable = async () => ({ ok: false, error }) as never;
      expect(
        await invoke(plane, "PATCH", "/api/v1/workspace-pools/pool", { name: "changed" }),
      ).toMatchObject({ status, json: { error: { code, message: error } } });
    }

    for (const [error, status, code] of [
      ["workspace pool not found", 404, "NOT_FOUND"],
      ["workspace pool is in use", 409, "CONFLICT"],
    ] as const) {
      const plane = new ControlPlane();
      plane.deleteWorkspacePoolDurable = async () => ({ ok: false, error }) as never;
      expect(await invoke(plane, "DELETE", "/api/v1/workspace-pools/pool")).toMatchObject({
        status,
        json: { error: { code, message: error } },
      });
    }

    const create = new ControlPlane();
    create.createWorkspacePoolDurable = async () =>
      ({
        ok: false,
        error: "workspace pool already exists",
      }) as never;
    expect(await invoke(create, "POST", "/api/v1/workspace-pools", { name: "pool" })).toMatchObject(
      {
        status: 400,
        json: { error: { code: "VALIDATION_ERROR", message: "workspace pool already exists" } },
      },
    );
  });
});
