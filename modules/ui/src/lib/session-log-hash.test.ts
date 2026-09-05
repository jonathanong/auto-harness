import { describe, expect, it, vi } from "vitest";

import { logLineHash, parseLogLineHash, replaceLogLineHash } from "./session-log-hash.ts";

describe("session log hashes", () => {
  it("parses GitHub-style line hashes", () => {
    expect(parseLogLineHash("#L12")).toBe(12);
    expect(parseLogLineHash("#L0")).toBeUndefined();
    expect(parseLogLineHash("#l1")).toBeUndefined();
    expect(parseLogLineHash("#L1-2")).toBeUndefined();
    expect(logLineHash(4)).toBe("#L4");
  });

  it("replaces the location hash without a navigation", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("location", {
      pathname: "/sessions/s1",
      search: "",
      href: "https://example.test/sessions/s1",
      hash: "",
    });
    vi.stubGlobal("history", { replaceState });
    const href = replaceLogLineHash(7);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/sessions/s1#L7");
    expect(href).toBe("https://example.test/sessions/s1");
    vi.unstubAllGlobals();
  });
});
