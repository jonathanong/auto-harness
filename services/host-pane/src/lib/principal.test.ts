import { afterEach, describe, expect, it, vi } from "vitest";

import { can, loadPrincipal } from "./principal.ts";
import { setApiTransportForTests } from "./api.ts";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  setApiTransportForTests(undefined);
  vi.unstubAllGlobals();
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

describe("host-pane principal", () => {
  it("keeps exec-config controls enabled when authentication is disabled", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    await expect(loadPrincipal()).resolves.toBeUndefined();
    expect(can(undefined, "fleet:exec-config")).toBe(true);
  });

  it("uses the authenticated capability returned by /auth/me", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    setApiTransportForTests(async () =>
      Response.json({
        username: "admin",
        role: "admin",
        kind: "user",
        capabilities: ["fleet:exec-config"],
      }),
    );
    const principal = await loadPrincipal();
    expect(principal && can(principal, "fleet:exec-config")).toBe(true);
    expect(
      can(
        { username: "operator", role: "operator", kind: "user", capabilities: [] },
        "fleet:exec-config",
      ),
    ).toBe(false);
  });
});
