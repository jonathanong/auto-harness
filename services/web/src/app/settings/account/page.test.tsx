import { afterEach, describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../../route-test-helpers.tsx";
import AccountSettingsPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

describe("account settings page", () => {
  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
    else process.env.HARNESS_AUTH_MODE = originalAuthMode;
  });

  it("hides account chrome when authentication is disabled", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    const html = await renderPage(AccountSettingsPage());
    expect(html).toContain("Authentication disabled");
    expect(html).not.toContain('data-pw="account-details"');
    expect(html).not.toContain("User accounts");
    expect(html).not.toContain("Service accounts");
  });

  it("renders account details and password change for a user", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "operator", role: "operator", kind: "user" },
    });
    const html = await renderPage(AccountSettingsPage());
    expect(html).toContain('data-pw="account-details"');
    expect(html).toContain("operator");
    expect(html).toContain('data-pw="change-password-card"');
    expect(html).not.toContain("Authentication disabled");
  });

  it("shows password rotation copy for bootstrap admins", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "admin", role: "admin", kind: "admin" },
    });
    const html = await renderPage(AccountSettingsPage());
    expect(html).toContain('data-pw="account-details"');
    expect(html).toContain("Password rotation");
  });
});
