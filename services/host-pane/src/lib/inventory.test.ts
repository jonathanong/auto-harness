import { afterEach, describe, expect, it } from "vitest";

import { apiGetAllPages, setApiTransportForTests } from "./api.ts";
import {
  loadHostInventoryWithVersion,
  loadLiveWorktreesById,
  loadRepoCatalog,
} from "./inventory.ts";

afterEach(() => setApiTransportForTests(undefined));

describe("loadHostInventoryWithVersion", () => {
  it("returns the real version a persisted inventory was read at", async () => {
    setApiTransportForTests(async () =>
      Response.json({
        setupScript: "source ~/.zshrc",
        setupCacheInputs: ["pnpm-lock.yaml"],
        allowedRoots: ["/opt/harness"],
        requiredEnvironment: ["TOKEN"],
        repositories: [],
        providerAccounts: [],
        version: 7,
      }),
    );

    await expect(loadHostInventoryWithVersion("host-a")).resolves.toEqual({
      inventory: {
        setupScript: "source ~/.zshrc",
        setupCacheInputs: ["pnpm-lock.yaml"],
        allowedRoots: ["/opt/harness"],
        requiredEnvironment: ["TOKEN"],
        repositories: [],
        providerAccounts: [],
      },
      version: 7,
    });
  });

  it("reads a pre-versioning record's missing version as 0", async () => {
    setApiTransportForTests(async () => Response.json({ repositories: [], providerAccounts: [] }));

    const { version } = await loadHostInventoryWithVersion("host-a");
    expect(version).toBe(0);
  });
});

describe("loadLiveWorktreesById", () => {
  it("follows worktree cursors for the requested host", async () => {
    const requests: string[] = [];
    setApiTransportForTests(async (input) => {
      requests.push(String(input));
      return requests.length === 1
        ? Response.json({ items: [{ id: "wt-1", status: "busy" }], nextCursor: "next/page" })
        : Response.json({ items: [{ id: "wt-2", online: true }], nextCursor: null });
    });
    await expect(loadLiveWorktreesById("host-a")).resolves.toEqual({
      "wt-1": { status: "busy", online: undefined },
      "wt-2": { status: undefined, online: true },
    });
    expect(requests[0]).toMatch(/hostId=host-a/);
    expect(requests[1]).toMatch(/cursor=next%2Fpage/);
  });
});

describe("loadRepoCatalog", () => {
  it("loads every repository page", async () => {
    const requests: string[] = [];
    setApiTransportForTests(async (input) => {
      requests.push(String(input));
      return requests.length === 1
        ? Response.json({ items: [{ id: "b", name: "Bravo" }], nextCursor: "next/page" })
        : Response.json({ items: [{ id: "a", name: "Alpha" }], nextCursor: null });
    });

    await expect(loadRepoCatalog()).resolves.toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ]);
    expect(requests[1]).toMatch(/\/api\/v1\/repositories\?limit=100&cursor=next%2Fpage$/);
  });

  it("rejects a replayed continuation", async () => {
    setApiTransportForTests(async () => Response.json({ items: [], nextCursor: "repeated" }));
    await expect(apiGetAllPages("/api/v1/repositories")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });
});
