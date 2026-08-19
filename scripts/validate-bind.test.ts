import { describe, expect, it } from "vitest";

import { isLoopbackHost, validateBindHost } from "./validate-bind.mts";

describe("validate-bind", () => {
  it("allows loopback by default", () => {
    expect(isLoopbackHost("")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(validateBindHost("HARNESS_WEB_HOST", {})).toEqual({ ok: true });
  });

  it("refuses a public bind without required auth", () => {
    const result = validateBindHost("HARNESS_WEB_HOST", { HARNESS_WEB_HOST: "0.0.0.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HARNESS_AUTH_MODE=required/);
  });

  it("allows a public bind when auth is fully configured", () => {
    expect(
      validateBindHost("HARNESS_HOST_PANE_HOST", {
        HARNESS_HOST_PANE_HOST: "0.0.0.0",
        HARNESS_AUTH_MODE: "required",
        HARNESS_SESSION_SECRET: "x".repeat(32),
        HARNESS_ADMINS: "W10=",
      }),
    ).toEqual({ ok: true });
  });
});
