import { describe, expect, it } from "vitest";

import { buildSessionsApiPath, parseSessionListQuery, sessionListHref } from "./list-query.ts";

describe("list-query", () => {
  it("parses session list query", () => {
    expect(parseSessionListQuery(new URLSearchParams())).toEqual({
      status: "all",
      q: "",
      concurrencyId: "",
      cursor: "",
      limit: 50,
      repositoryId: "",
      scheduleId: "",
      sort: "latest",
    });
    expect(
      parseSessionListQuery(
        new URLSearchParams("status=running&q=x&concurrencyId=pr-1&cursor=c1&limit=5&sort=oldest"),
      ),
    ).toEqual({
      status: "running",
      q: "x",
      concurrencyId: "pr-1",
      cursor: "c1",
      limit: 5,
      repositoryId: "",
      scheduleId: "",
      sort: "oldest",
    });
  });

  it("falls back to the default limit for non-numeric or non-positive input", () => {
    expect(parseSessionListQuery(new URLSearchParams("limit=abc")).limit).toBe(50);
    expect(parseSessionListQuery(new URLSearchParams("limit=-5")).limit).toBe(50);
  });

  it("caps the limit at 100", () => {
    expect(parseSessionListQuery(new URLSearchParams("limit=500")).limit).toBe(100);
  });

  it("uses supplied defaults and falls back from an unsupported sort", () => {
    expect(parseSessionListQuery(new URLSearchParams(), { limit: 25 }).limit).toBe(25);
    expect(parseSessionListQuery(new URLSearchParams("sort=not-supported")).sort).toBe("latest");
  });

  it("builds session list hrefs", () => {
    expect(sessionListHref({})).toBe("/sessions");
    expect(sessionListHref({ status: "failed", q: "a", concurrencyId: "pr-1", cursor: "c" })).toBe(
      "/sessions?status=failed&q=a&concurrencyId=pr-1&cursor=c",
    );
  });

  it("omits limit at the default and includes it otherwise", () => {
    expect(sessionListHref({ limit: 50 })).toBe("/sessions");
    expect(sessionListHref({ limit: 20 })).toBe("/sessions?limit=20");
  });

  it("includes every supported navigation filter", () => {
    expect(
      sessionListHref({ repositoryId: "repo-1", scheduleId: "schedule-1", sort: "oldest" }),
    ).toBe("/sessions?repositoryId=repo-1&scheduleId=schedule-1&sort=oldest");
  });

  it("builds API paths", () => {
    const path = buildSessionsApiPath(
      {
        status: "queued",
        q: "",
        concurrencyId: "",
        cursor: "",
        limit: 10,
        repositoryId: "",
        scheduleId: "",
        sort: "latest",
      },
      { hostId: "local-1" },
    );
    expect(path).toContain("limit=10");
    expect(path).toContain("status=queued");
    expect(path).toContain("hostId=local-1");
  });

  it("includes cursor and filters but never sends client-side q", () => {
    const path = buildSessionsApiPath({
      status: "all",
      q: "hello",
      concurrencyId: "pr-1",
      cursor: "c1",
      limit: 20,
      repositoryId: "repo-1",
      scheduleId: "schedule-1",
      sort: "priority_desc",
    });
    expect(path).toContain("cursor=c1");
    expect(path).not.toContain("q=hello");
    expect(path).toContain("concurrencyId=pr-1");
    expect(path).toContain("repositoryId=repo-1");
    expect(path).toContain("scheduleId=schedule-1");
    expect(path).toContain("sort=priority_desc");
  });
});
