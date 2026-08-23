import { afterEach, describe, expect, it, vi } from "vitest";

import { apiGetAllPages } from "./api.ts";

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

    await expect(apiGetAllPages<{ id: string }>("/api/v1/repositories")).resolves.toEqual([
      { id: "first" },
      { id: "second" },
    ]);
    expect(requests[1]).toMatch(/\/api\/v1\/repositories\?cursor=next%2Fpage$/);
  });

  it("rejects a replayed continuation instead of looping forever", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ items: [], nextCursor: "repeated" }));
    await expect(apiGetAllPages("/api/v1/repositories")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });
});
