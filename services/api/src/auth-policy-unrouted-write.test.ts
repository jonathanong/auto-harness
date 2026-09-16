import { describe, expect, it } from "vitest";

import { authorize, isUnroutedWrite, requiredCapability } from "./auth-policy.ts";
import type { Principal } from "./auth.ts";

/**
 * Found on live production: every unknown POST under /api/v1/ answered
 * 403 "insufficient role for this operation", so a mistyped URL read as a
 * permissions problem. `POST /hosts/:id/drain` is the easy wrong guess, since
 * `POST /repositories/:id/drain` really does take a path parameter — and the
 * same bad path already 404s for GET.
 */
describe("unrouted writes are a routing fact, not an authorization one", () => {
  const admin = {
    id: "u",
    role: "admin",
    capabilities: undefined,
  } as unknown as Principal;

  it("flags writes that match no route", () => {
    expect(isUnroutedWrite("POST", "/api/v1/hosts/some-host/drain")).toBe(true);
    expect(isUnroutedWrite("POST", "/api/v1/hosts/some-host/resume")).toBe(true);
    expect(isUnroutedWrite("POST", "/api/v1/hosts/some-host/frobnicate")).toBe(true);
    expect(isUnroutedWrite("POST", "/api/v1/frobnicate")).toBe(true);
  });

  it("does not flag real write routes, whatever the caller may lack", () => {
    // These resolve to a capability, so a denial really is about the principal.
    expect(isUnroutedWrite("POST", "/api/v1/hosts/drain")).toBe(false);
    expect(isUnroutedWrite("POST", "/api/v1/hosts/resume")).toBe(false);
    expect(isUnroutedWrite("POST", "/api/v1/repositories/some-repo/drain")).toBe(false);
    expect(isUnroutedWrite("POST", "/api/v1/sessions")).toBe(false);
    expect(requiredCapability("POST", "/api/v1/hosts/drain")).toBe("fleet:drain");
  });

  it("does not flag safe methods, which route normally and 404 on their own", () => {
    expect(isUnroutedWrite("GET", "/api/v1/hosts/some-host/frobnicate")).toBe(false);
    expect(isUnroutedWrite("GET", "/api/v1/frobnicate")).toBe(false);
  });

  it("keeps failing closed: an unrouted write is still denied", () => {
    // The point of the fix is the reported reason, never the outcome. Even an
    // admin must not be authorized through a path that matches no route.
    expect(authorize(admin, "POST", "/api/v1/hosts/some-host/drain")).toBe(false);
    expect(authorize(admin, "POST", "/api/v1/frobnicate")).toBe(false);
  });

  it("leaves non-/api/v1 writes alone", () => {
    // requiredCapability returns "authenticated" for these, not null.
    expect(isUnroutedWrite("POST", "/healthz")).toBe(false);
  });
});
