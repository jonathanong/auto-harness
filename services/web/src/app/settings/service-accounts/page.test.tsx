import { afterEach, describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../../route-test-helpers.tsx";
import ServiceAccountsSettingsPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

describe("service accounts settings page", () => {
  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
    else process.env.HARNESS_AUTH_MODE = originalAuthMode;
  });

  it("renders nothing when authentication is disabled", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    const html = await renderPage(ServiceAccountsSettingsPage());
    expect(html).toBe("");
  });

  it("shows a permission error for operators", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "operator", role: "operator", kind: "user" },
    });
    const html = await renderPage(ServiceAccountsSettingsPage());
    expect(html).toContain("Service accounts");
    expect(html).toContain("An unscoped admin account is required");
  });
});
