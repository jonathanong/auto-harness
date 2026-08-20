import { describe, expect, it } from "vitest";

import { decodeRouteParam } from "./decode-route-param.ts";

describe("decodeRouteParam", () => {
  it("returns values without % unchanged", () => {
    expect(decodeRouteParam("host-a")).toBe("host-a");
    expect(decodeRouteParam("admin:admin")).toBe("admin:admin");
    expect(decodeRouteParam("")).toBe("");
  });

  it("decodes a percent-encoded value once", () => {
    expect(decodeRouteParam("admin%3Aadmin")).toBe("admin:admin");
    expect(decodeRouteParam("admin%3aadmin")).toBe("admin:admin");
    expect(decodeRouteParam("host%2Fname")).toBe("host/name");
    expect(decodeRouteParam("admin%253Aadmin")).toBe("admin%3Aadmin");
  });

  it("returns the original string when decodeURIComponent throws", () => {
    expect(decodeRouteParam("%")).toBe("%");
    expect(decodeRouteParam("%2")).toBe("%2");
    expect(decodeRouteParam("%ZZ")).toBe("%ZZ");
    expect(decodeRouteParam("host%name")).toBe("host%name");
  });
});
