import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch, apiFetchAllPages } from "./client-api.ts";

describe("browser API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses same-origin cookies unless the caller specifies credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/v1/sessions", { method: "GET" });
    await apiFetch("/api/v1/sessions", { credentials: "include" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/sessions", {
      method: "GET",
      credentials: "same-origin",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/sessions", {
      credentials: "include",
    });
  });

  it("redirects expired browser sessions to a safe login return path", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/sessions", search: "?status=queued", assign },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await apiFetch("/api/v1/sessions");
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fsessions%3Fstatus%3Dqueued");
  });

  it("leaves explicit login errors and non-browser callers in place", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/login", search: "", assign } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await apiFetch("/api/v1/auth/login", undefined, { redirectOnUnauthorized: false });
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(apiFetch("/api/v1/sessions")).resolves.toBeInstanceOf(Response);
  });

  it("loads browser catalog pages and preserves an HTTP failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [{ id: "one" }], nextCursor: "next/page" }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: "two" }], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetchAllPages<{ id: string }>("/api/v1/repositories")).resolves.toMatchObject({
      items: [{ id: "one" }, { id: "two" }],
      response: expect.objectContaining({ ok: true }),
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/repositories?cursor=next%2Fpage");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(apiFetchAllPages("/api/v1/repositories")).resolves.toMatchObject({
      items: [],
      response: expect.objectContaining({ status: 503 }),
    });
  });

  it("rejects a replayed browser continuation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextCursor: "repeated" })),
    );
    await expect(apiFetchAllPages("/api/v1/repositories")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });
});
