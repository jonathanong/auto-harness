import { describe, expect, it } from "vitest";

import {
  hostListHref,
  parseHostListState,
  parseSessionListState,
  sessionListHref,
} from "./url-state.ts";

describe("url-state", () => {
  it("parses and serializes session list filters", () => {
    expect(parseSessionListState(new URLSearchParams())).toEqual({
      status: "all",
      q: "",
      cursor: "",
      limit: 20,
    });
    const sp = new URLSearchParams("status=running&q=sess&cursor=abc");
    expect(parseSessionListState(sp)).toEqual({
      status: "running",
      q: "sess",
      cursor: "abc",
      limit: 20,
    });
    expect(sessionListHref({})).toBe("/sessions");
    expect(sessionListHref({ status: "all", q: "", cursor: "" })).toBe("/sessions");
    expect(sessionListHref({ status: "failed" })).toBe("/sessions?status=failed");
    expect(sessionListHref({ q: "x" })).toBe("/sessions?q=x");
    expect(sessionListHref({ status: "failed", q: "x" })).toBe("/sessions?status=failed&q=x");
    expect(sessionListHref({ cursor: "c1" })).toBe("/sessions?cursor=c1");
  });

  it("parses and serializes host list filters", () => {
    expect(parseHostListState(new URLSearchParams())).toEqual({ online: "all" });
    expect(parseHostListState(new URLSearchParams("online=online"))).toEqual({
      online: "online",
    });
    expect(hostListHref({})).toBe("/hosts");
    expect(hostListHref({ online: "all" })).toBe("/hosts");
    expect(hostListHref({ online: "offline" })).toBe("/hosts?online=offline");
  });
});
