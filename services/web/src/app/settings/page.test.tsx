import { afterEach, describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../route-test-helpers.tsx";
import SettingsPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

describe("settings page", () => {
  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
    else process.env.HARNESS_AUTH_MODE = originalAuthMode;
  });

  it("hides user and service account chrome when authentication is disabled", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    const html = await renderPage(SettingsPage());
    expect(html).toContain("Authentication disabled");
    expect(html).not.toContain("Service accounts");
    expect(html).not.toContain("User accounts");
    expect(html).not.toContain("An unscoped admin account is required");
    expect(html).not.toContain('data-pw="account-details"');
  });

  it("renders account-management chrome when authentication is required", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "operator", role: "operator", kind: "user" },
    });
    const html = await renderPage(SettingsPage());
    expect(html).toContain('data-pw="account-details"');
    expect(html).toContain("operator");
    expect(html).toContain('data-pw="change-password-card"');
    expect(html).toContain("User accounts");
    expect(html).toContain("Service accounts");
    expect(html).toContain("An unscoped admin account is required");
    expect(html).not.toContain("Authentication disabled");
  });

  it("lets an unscoped admin manage accounts when authentication is required", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "admin", role: "admin", kind: "admin" },
    });
    const html = await renderPage(SettingsPage());
    expect(html).toContain('data-pw="account-details"');
    expect(html).toContain("Password rotation");
    expect(html).toContain('data-pw="user-accounts-loading"');
    expect(html).not.toContain("An unscoped admin account is required");
  });
});
