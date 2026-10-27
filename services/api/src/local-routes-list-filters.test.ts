import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { handleCommandRoutes } from "./local-routes-commands.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { handleProviderAccountRoutes } from "./local-routes-provider-accounts.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

type Handler = typeof handleCommandRoutes;

async function get(handler: Handler, plane: ControlPlane, path: string) {
  return await invokeHandler(
    async (req, res) => {
      await handler({
        plane,
        req,
        res,
        url: new URL(path, "http://localhost"),
        method: "GET",
      } as never);
    },
    "GET",
    path,
  );
}

function ids(response: { json: unknown }): string[] {
  return (response.json as { items: Array<{ id?: string; hostId?: string }> }).items.map(
    (item) => item.id ?? item.hostId!,
  );
}

const repo = (id: string) => ({ id, path: `/${id}`, defaultBranch: "main", worktrees: [] });

function seedCatalog(plane: ControlPlane) {
  plane.createProvider({ id: "prov-1", name: "claude" });
  plane.createProvider({ id: "prov-2", name: "codex" });
  for (const [id, providerId] of [
    ["cmd-a", "prov-1"],
    ["cmd-b", "prov-2"],
    ["cmd-c", "prov-1"],
    ["cmd-d", null],
  ] as const) {
    plane.createCommand({ id, name: id, argv: [id], providerId });
  }
  let n = 0;
  for (const providerId of ["prov-1", "prov-2", "prov-1"]) {
    plane.createProviderAccount({ providerId, label: `acct-${(n += 1)}` });
  }
}

describe("commands providerId filter", () => {
  it("filters before pagination and keeps cursors correct", async () => {
    const plane = new ControlPlane();
    seedCatalog(plane);
    const first = await get(
      handleCommandRoutes,
      plane,
      "/api/v1/commands?providerId=prov-1&limit=1",
    );
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual(["cmd-a"]);
    const cursor = (first.json as { nextCursor: string }).nextCursor;
    expect(cursor).toBeTruthy();
    const second = await get(
      handleCommandRoutes,
      plane,
      `/api/v1/commands?providerId=prov-1&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(ids(second)).toEqual(["cmd-c"]);
    expect((second.json as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  it("validates the param and rejects storage cursors", async () => {
    const plane = new ControlPlane();
    seedCatalog(plane);
    expect((await get(handleCommandRoutes, plane, "/api/v1/commands?providerId=")).status).toBe(
      400,
    );
    expect(
      (await get(handleCommandRoutes, plane, "/api/v1/commands?providerId=a&providerId=b")).status,
    ).toBe(400);
    expect(
      (await get(handleCommandRoutes, plane, "/api/v1/commands?providerId=prov-1&cursor=s1.abc"))
        .status,
    ).toBe(400);
  });
});

describe("provider-accounts providerId filter", () => {
  it("filters before pagination and validates the param", async () => {
    const plane = new ControlPlane();
    seedCatalog(plane);
    const all = await get(handleProviderAccountRoutes, plane, "/api/v1/provider-accounts");
    expect(ids(all)).toHaveLength(3);
    const filtered = await get(
      handleProviderAccountRoutes,
      plane,
      "/api/v1/provider-accounts?providerId=prov-1&limit=1",
    );
    expect(ids(filtered)).toHaveLength(1);
    const next = await get(
      handleProviderAccountRoutes,
      plane,
      `/api/v1/provider-accounts?providerId=prov-1&limit=1&cursor=${encodeURIComponent(
        (filtered.json as { nextCursor: string }).nextCursor,
      )}`,
    );
    expect(ids(next)).toHaveLength(1);
    expect(ids(next)).not.toEqual(ids(filtered));
    expect((next.json as { nextCursor: string | null }).nextCursor).toBeNull();
    expect(
      ids(
        await get(handleProviderAccountRoutes, plane, "/api/v1/provider-accounts?providerId=none"),
      ),
    ).toEqual([]);
    expect(
      (await get(handleProviderAccountRoutes, plane, "/api/v1/provider-accounts?providerId="))
        .status,
    ).toBe(400);
  });
});

describe("host-inventories repositoryId filter", () => {
  it("returns only inventories attached to the repository", async () => {
    const plane = new ControlPlane();
    await plane.putHostInventoryDurable("host-1", {
      repositories: [repo("repo-a"), repo("repo-b")],
      commandProfiles: {},
    });
    await plane.putHostInventoryDurable("host-2", {
      repositories: [repo("repo-b")],
      commandProfiles: {},
    });
    await plane.putHostInventoryDurable("host-3", {
      repositories: [repo("repo-c")],
      commandProfiles: {},
    });
    expect(
      ids(
        await get(handleHostInventoryRoutes, plane, "/api/v1/host-inventories?repositoryId=repo-b"),
      ),
    ).toEqual(["host-1", "host-2"]);
    const page = await get(
      handleHostInventoryRoutes,
      plane,
      "/api/v1/host-inventories?repositoryId=repo-b&limit=1",
    );
    expect(ids(page)).toEqual(["host-1"]);
    expect((page.json as { nextCursor: string }).nextCursor).toBe("host-1");
    expect(
      ids(await get(handleHostInventoryRoutes, plane, "/api/v1/host-inventories?repositoryId=x")),
    ).toEqual([]);
    expect(
      (await get(handleHostInventoryRoutes, plane, "/api/v1/host-inventories?repositoryId="))
        .status,
    ).toBe(400);
  });
});
