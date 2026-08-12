import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

const scoped: Principal = {
  id: "service:host-1",
  kind: "service-account",
  role: "operator",
  boundHostId: "host-1",
  allowedRepositoryIds: ["repo-allowed"],
};

const inventory = {
  repositories: [
    { id: "repo-allowed", path: "/allowed", defaultBranch: "main", worktrees: [] },
    { id: "repo-hidden", path: "/hidden", defaultBranch: "main", worktrees: [] },
  ],
  commandProfiles: {},
};

describe("host inventory route outcomes", () => {
  it("filters list and detail reads for unscoped and repository-scoped callers", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(await invoke(plane, "GET", "/api/v1/host-inventories")).toMatchObject({
      status: 200,
      json: { items: [expect.objectContaining({ hostId: "host-1" })] },
    });
    expect(await invoke(plane, "GET", "/api/v1/hosts/host-1/inventory")).toMatchObject({
      status: 200,
      json: expect.objectContaining({
        repositories: expect.arrayContaining([expect.objectContaining({ id: "repo-hidden" })]),
      }),
    });
    expect(await invoke(plane, "GET", "/api/v1/host-inventories", undefined, scoped)).toMatchObject(
      {
        status: 200,
        json: {
          items: [
            expect.objectContaining({
              repositories: [expect.objectContaining({ id: "repo-allowed" })],
            }),
          ],
        },
      },
    );

    const hidden: Principal = { ...scoped, allowedRepositoryIds: ["missing"] };
    expect(await invoke(plane, "GET", "/api/v1/host-inventories", undefined, hidden)).toMatchObject(
      {
        status: 200,
        json: { items: [] },
      },
    );
    expect(
      await invoke(plane, "GET", "/api/v1/hosts/host-1/inventory", undefined, hidden),
    ).toMatchObject({
      status: 404,
    });
    expect(
      await invoke(plane, "GET", "/api/v1/hosts/host-2/inventory", undefined, scoped),
    ).toMatchObject({
      status: 404,
    });
    expect(await invoke(new ControlPlane(), "GET", "/api/v1/hosts/host-1/inventory")).toMatchObject(
      {
        status: 404,
      },
    );
  });

  it("rejects malformed or out-of-scope writes before persistence", async () => {
    const plane = new ControlPlane();
    for (const body of [
      null,
      "not-an-object",
      {},
      { repositories: "not-an-array" },
      { repositories: [{}] },
      { repositories: [{ id: "repo-hidden" }] },
    ]) {
      expect(
        await invoke(plane, "PUT", "/api/v1/hosts/host-1/inventory", body, scoped),
      ).toMatchObject({
        status: 404,
      });
    }
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/inventory", {
        repositories: [{ id: "repo-allowed" }],
        commandProfiles: {},
      }),
    ).toMatchObject({ status: 400 });

    const handler = routeHandler(plane, "PUT", "/api/v1/hosts/host-1/inventory", scoped);
    expect(await invokeBadJson(handler, "PUT", "/api/v1/hosts/host-1/inventory")).toBe(400);
  });

  it("returns scoped writes, missing deletes, and false for unsupported methods", async () => {
    const plane = new ControlPlane();
    const body = {
      repositories: [
        { id: "repo-allowed", path: "/allowed", defaultBranch: "main", worktrees: [] },
      ],
      commandProfiles: {},
    };
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/inventory", body, scoped),
    ).toMatchObject({
      status: 200,
      json: expect.objectContaining({
        repositories: [expect.objectContaining({ id: "repo-allowed" })],
      }),
    });
    expect(await invoke(plane, "DELETE", "/api/v1/hosts/missing/inventory")).toMatchObject({
      status: 404,
    });
    expect(await invoke(plane, "DELETE", "/api/v1/hosts/host-1/inventory")).toMatchObject({
      status: 204,
    });
    expect(await invoke(plane, "PATCH", "/api/v1/hosts/host-1/inventory")).toMatchObject({
      status: 418,
      handled: false,
    });
    expect(await invoke(plane, "GET", "/different-route")).toMatchObject({
      status: 418,
      handled: false,
    });
  });

  it("maps each durable boundary failure to an internal error", async () => {
    const plane = {
      listHostInventoriesDurable: failure,
      getHostInventoryDurable: failure,
      putHostInventoryDurable: failure,
      deleteHostInventoryDurable: failure,
    } as unknown as ControlPlane;
    for (const [method, path, body] of [
      ["GET", "/api/v1/host-inventories", undefined],
      ["GET", "/api/v1/hosts/host-1/inventory", undefined],
      ["PUT", "/api/v1/hosts/host-1/inventory", { repositories: [], commandProfiles: {} }],
      ["DELETE", "/api/v1/hosts/host-1/inventory", undefined],
    ] as const) {
      expect(await invoke(plane, method, path, body)).toMatchObject({
        status: 500,
        json: { error: { code: "INTERNAL_ERROR" } },
      });
    }
  });
});

async function failure(): Promise<never> {
  throw new Error("storage failed");
}

function routeHandler(plane: ControlPlane, method: string, path: string, principal?: Principal) {
  return async (req: never, res: never) =>
    await handleHostInventoryRoutes({
      plane,
      req,
      res,
      url: new URL(path, "http://localhost"),
      method,
      ...(principal ? { principal } : {}),
    });
}

async function invoke(
  plane: ControlPlane,
  method: string,
  path: string,
  body?: unknown,
  principal?: Principal,
) {
  let handled = true;
  const response = await invokeHandler(
    async (req, res) => {
      handled = await routeHandler(plane, method, path, principal)(req, res);
      if (!handled) {
        (res as unknown as { writeHead(status: number): void }).writeHead(418);
        (res as unknown as { end(): void }).end();
      }
    },
    method,
    path,
    body,
  );
  return { ...response, handled };
}
