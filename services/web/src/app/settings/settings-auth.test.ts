import { afterEach, describe, expect, it } from "vitest";

import { stubApi } from "../route-test-helpers.tsx";
import { canManageAccounts, loadSettingsPrincipal } from "./settings-auth.ts";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

describe("settings auth helpers", () => {
  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
    else process.env.HARNESS_AUTH_MODE = originalAuthMode;
  });

  it("loads no principal when authentication is disabled", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    expect(await loadSettingsPrincipal()).toBeUndefined();
  });

  it("loads the signed principal when authentication is required", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "admin", role: "admin", kind: "admin" },
    });
    expect(await loadSettingsPrincipal()).toEqual({
      username: "admin",
      role: "admin",
      kind: "admin",
    });
  });

  it("allows only unscoped admins to manage accounts", () => {
    expect(canManageAccounts({ username: "admin", role: "admin", kind: "admin" })).toBe(true);
    expect(
      canManageAccounts({
        username: "scoped",
        role: "admin",
        kind: "admin",
        allowedRepositoryIds: ["repo"],
      }),
    ).toBe(false);
    expect(
      canManageAccounts({
        username: "host-admin",
        role: "admin",
        kind: "user",
        boundHostId: "host-1",
      }),
    ).toBe(false);
    expect(canManageAccounts({ username: "operator", role: "operator", kind: "user" })).toBe(false);
    expect(canManageAccounts({ username: "maintainer", role: "maintainer", kind: "user" })).toBe(
      false,
    );
  });
});
