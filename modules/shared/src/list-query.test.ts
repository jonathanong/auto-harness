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

  it("builds session list hrefs", () => {
    expect(sessionListHref({})).toBe("/sessions");
    expect(sessionListHref({ status: "failed", q: "a", cursor: "c" })).toBe(
      "/sessions?status=failed&q=a&cursor=c",
    );
  });

  it("builds API paths", () => {
    const path = buildSessionsApiPath(
      { status: "queued", q: "", cursor: "", limit: 10 },
      { agentId: "local-1" },
    );
    expect(path).toContain("limit=10");
    expect(path).toContain("status=queued");
    expect(path).toContain("agentId=local-1");
  });
});
