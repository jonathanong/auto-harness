import { afterEach, describe, expect, it, vi } from "vitest";

import { apiGetAllPages, apiGetFirstPageWithItems } from "./api.ts";

describe("apiGetAllPages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows and encodes every continuation cursor", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      requests.push(String(input));
      return requests.length === 1
        ? Response.json({ items: [{ id: "first" }], nextCursor: "next/page" })
        : Response.json({ items: [{ id: "second" }], nextCursor: null });
    });

    await expect(apiGetAllPages<{ id: string }>("/api/v1/repositories?limit=100")).resolves.toEqual(
      [{ id: "first" }, { id: "second" }],
    );
    expect(requests[1]).toMatch(/\/api\/v1\/repositories\?limit=100&cursor=next%2Fpage$/);
  });

  it("rejects a replayed continuation instead of looping forever", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ items: [], nextCursor: "repeated" }));
    await expect(apiGetAllPages("/api/v1/repositories")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });

  it("advances through empty pages until it finds an item", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      requests.push(String(input));
      return requests.length === 1
        ? Response.json({ items: [], nextCursor: "sparse/page" })
        : Response.json({ items: [{ id: "found" }], nextCursor: "more" });
    });

    await expect(
      apiGetFirstPageWithItems<{ id: string }>("/api/v1/sessions?limit=50"),
    ).resolves.toEqual({ items: [{ id: "found" }], nextCursor: "more" });
    expect(requests[1]).toMatch(/\/api\/v1\/sessions\?limit=50&cursor=sparse%2Fpage$/);
  });

  it("rejects a replayed sparse continuation", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ items: [], nextCursor: "repeated" }));
    await expect(apiGetFirstPageWithItems("/api/v1/sessions")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });

  it("bounds sparse-page traversal", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () =>
      Response.json({ items: [], nextCursor: `sparse-${calls++}` }),
    );
    await expect(apiGetFirstPageWithItems("/api/v1/sessions")).rejects.toThrow(
      "pagination exceeded 20 pages",
    );
  });
});
