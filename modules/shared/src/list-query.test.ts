import { describe, expect, it } from "vitest";

import { buildSessionsApiPath, parseSessionListQuery, sessionListHref } from "./list-query.ts";

describe("list-query", () => {
  it("parses session list query", () => {
    expect(parseSessionListQuery(new URLSearchParams())).toEqual({
      status: "all",
      q: "",
      cursor: "",
      limit: 20,
    });
    expect(
      parseSessionListQuery(new URLSearchParams("status=running&q=x&cursor=c1&limit=5")),
    ).toEqual({
      status: "running",
      q: "x",
      cursor: "c1",
      limit: 5,
    });
  });

  it("falls back to the default limit for non-numeric or non-positive input", () => {
    expect(parseSessionListQuery(new URLSearchParams("limit=abc")).limit).toBe(20);
    expect(parseSessionListQuery(new URLSearchParams("limit=-5")).limit).toBe(20);
  });

  it("caps the limit at 100", () => {
    expect(parseSessionListQuery(new URLSearchParams("limit=500")).limit).toBe(100);
  });

  it("builds session list hrefs", () => {
    expect(sessionListHref({})).toBe("/sessions");
    expect(sessionListHref({ status: "failed", q: "a", cursor: "c" })).toBe(
      "/sessions?status=failed&q=a&cursor=c",
    );
  });

  it("omits limit at the default and includes it otherwise", () => {
    expect(sessionListHref({ limit: 20 })).toBe("/sessions");
    expect(sessionListHref({ limit: 50 })).toBe("/sessions?limit=50");
  });

  it("builds API paths", () => {
    const path = buildSessionsApiPath(
      { status: "queued", q: "", cursor: "", limit: 10 },
      { hostId: "local-1" },
    );
    expect(path).toContain("limit=10");
    expect(path).toContain("status=queued");
    expect(path).toContain("hostId=local-1");
  });

  it("includes cursor and q when present", () => {
    const path = buildSessionsApiPath({ status: "all", q: "hello", cursor: "c1", limit: 20 });
    expect(path).toContain("cursor=c1");
    expect(path).toContain("q=hello");
  });
});
