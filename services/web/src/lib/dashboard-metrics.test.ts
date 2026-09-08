// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSessionCount, getItemPage, getItems, getSessionCount } from "./dashboard-metrics.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("getItems", () => {
  it("returns the items array from a successful response", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ items: [{ id: "a" }] }));
    await expect(getItems("/api/v1/sessions")).resolves.toEqual([{ id: "a" }]);
  });

  it("defaults to an empty array when items is missing", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}));
    await expect(getItems("/api/v1/sessions")).resolves.toEqual([]);
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}, 500));
    await expect(getItems("/api/v1/sessions")).rejects.toThrow("request failed (500)");
  });
});

describe("getItemPage", () => {
  it("reports atLimit from nextCursor", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ items: [{ id: "a" }], nextCursor: "next" }));
    await expect(getItemPage("/api/v1/hosts")).resolves.toEqual({
      items: [{ id: "a" }],
      atLimit: true,
    });
  });

  it("skips empty nonterminal pages before returning a bounded page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: "sparse" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "a" }], nextCursor: "more" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getItemPage("/api/v1/sessions?limit=50")).resolves.toEqual({
      items: [{ id: "a" }],
      atLimit: true,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/sessions?limit=50&cursor=sparse");
  });
});

describe("getSessionCount", () => {
  it("reports an exact count when under the server limit", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ items: [{ id: "a" }], nextCursor: null }));
    await expect(getSessionCount("running")).resolves.toEqual({ count: 1, atLimit: false });
  });

  it("reports atLimit once a nextCursor is present", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ items: [{ id: "a" }], nextCursor: "next" }));
    await expect(getSessionCount("queued")).resolves.toEqual({ count: 1, atLimit: true });
  });

  it("skips empty nonterminal pages when counting a status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: "sparse" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "a" }], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSessionCount("queued")).resolves.toEqual({ count: 1, atLimit: false });
  });

  it("defaults count to 0 and atLimit to false when fields are missing", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}));
    await expect(getSessionCount("running")).resolves.toEqual({ count: 0, atLimit: false });
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}, 500));
    await expect(getSessionCount("running")).rejects.toThrow("request failed (500)");
  });
});

describe("formatSessionCount", () => {
  it("renders the exact count when not at the limit", () => {
    expect(formatSessionCount({ count: 3, atLimit: false })).toBe("3");
  });

  it("renders a '+' suffix when at the limit", () => {
    expect(formatSessionCount({ count: 100, atLimit: true })).toBe("100+");
  });
});
