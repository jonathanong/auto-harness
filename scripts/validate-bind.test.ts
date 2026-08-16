import { describe, expect, it } from "vitest";

import { isLoopback, validateBind } from "./validate-bind.mts";

const configured = {
  HARNESS_AUTH_MODE: "required",
  HARNESS_SESSION_SECRET: "s".repeat(32),
  HARNESS_ADMINS: "eyJhIjoxfQ",
} satisfies NodeJS.ProcessEnv;

describe("validateBind", () => {
  it("allows the default, unset host", () => {
    expect(validateBind("HARNESS_WEB_HOST", {})).toBeNull();
  });

  it("allows every loopback spelling without auth configured", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(isLoopback(host)).toBe(true);
      expect(validateBind("HARNESS_WEB_HOST", { HARNESS_WEB_HOST: host })).toBeNull();
    }
  });

  it("refuses a public bind when auth is not configured", () => {
    const refusal = validateBind("HARNESS_WEB_HOST", { HARNESS_WEB_HOST: "0.0.0.0" });

    expect(refusal).toContain("Refusing to bind HARNESS_WEB_HOST=0.0.0.0");
    expect(refusal).toContain("HARNESS_AUTH_MODE=required");
    expect(refusal).toContain("HARNESS_SESSION_SECRET");
    expect(refusal).toContain("HARNESS_ADMINS");
  });

  it("names only what is actually missing", () => {
    const refusal = validateBind("HARNESS_HOST_PANE_HOST", {
      ...configured,
      HARNESS_HOST_PANE_HOST: "10.0.0.5",
      HARNESS_ADMINS: "",
    });

    expect(refusal).toContain("HARNESS_ADMINS");
    expect(refusal).not.toContain("HARNESS_AUTH_MODE=required,");
  });

  it("rejects a session secret that is too short to sign with", () => {
    expect(
      validateBind("HARNESS_WEB_HOST", {
        ...configured,
        HARNESS_WEB_HOST: "10.0.0.5",
        HARNESS_SESSION_SECRET: "short",
      }),
    ).toContain("HARNESS_SESSION_SECRET");
  });

  it("allows a public bind once auth is fully configured", () => {
    expect(
      validateBind("HARNESS_WEB_HOST", { ...configured, HARNESS_WEB_HOST: "10.0.0.5" }),
    ).toBeNull();
  });
});
