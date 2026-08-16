import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";
import { API_BASE } from "../harness-endpoints.ts";

const apiUrl = `${API_BASE}/api/v1`;
const admin = { username: "auth-admin", password: "auth-password" };
const sessionSecret = "auth-e2e-session-secret-auth-e2e-session-secret";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test.describe("control plane required authentication", () => {
  test.skip(process.env.HARNESS_E2E_AUTH !== "1", "requires the dedicated required-auth E2E stack");

  test("login, safe return, password change, logout, and expiry redirect", async ({
    page,
    request,
  }) => {
    const username = `pw-auth-${test.info().parallelIndex}-${Date.now()}`;
    const password = "before-password";
    const nextPassword = "after-password";
    const basic = Buffer.from(`${admin.username}:${admin.password}`).toString("base64");
    const created = await request.post(`${apiUrl}/auth/users`, {
      headers: { authorization: `Basic ${basic}` },
      data: { username, password, role: "operator" },
    });
    expect(created.status()).toBe(201);

    try {
      await page.goto("/sessions?status=queued");
      await expect(page).toHaveURL(/\/login\?returnTo=%2Fsessions%3Fstatus%3Dqueued/);
      await expect(page.getByTestId("page-login")).toBeVisible();
      await expect(page.getByTestId("login-card")).toBeVisible();
      await expect(page.getByTestId("form-login")).toBeVisible();
      await page.getByTestId("login-username").fill(username);
      await page.getByTestId("login-password").fill("wrong-password");
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("login-error")).toHaveText("Invalid username or password.");

      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await expect(page).toHaveURL(/\/sessions\?status=queued$/);
      await expect(page.getByTestId("page-sessions")).toBeVisible();

      await page.getByTestId("nav-settings").click();
      await expect(page.getByTestId("page-settings")).toBeVisible();
      await expect(page.getByTestId("settings-heading")).toHaveText("Settings");
      await expect(page.getByTestId("account-details")).toBeVisible();
      await expect(page.getByTestId("account-username")).toHaveText(username);
      await expect(page.getByTestId("account-role")).toHaveText("operator");
      await expect(page.getByTestId("change-password-card")).toBeVisible();
      await expect(page.getByTestId("form-change-password")).toBeVisible();
      await page.getByTestId("change-password-current").fill("wrong-password");
      await page.getByTestId("change-password-new").fill(nextPassword);
      await page.getByTestId("change-password-submit").click();
      await expect(page.getByTestId("change-password-error")).toHaveText(
        "current password is incorrect",
      );
      await page.getByTestId("change-password-current").fill(password);
      await page.getByTestId("change-password-submit").click();
      await expect(page.getByTestId("change-password-ok")).toHaveText("Password changed.");

      await page.getByTestId("logout").click();
      await expect(page).toHaveURL(/\/login$/);
      await page.getByTestId("login-username").fill(username);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("login-error")).toBeVisible();
      await page.getByTestId("login-password").fill(nextPassword);
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("control-shell")).toBeVisible();

      await page.context().clearCookies();
      await page.context().addCookies([
        {
          name: "auto_harness_session",
          value: expiredSession(username),
          url: "http://127.0.0.1:7431",
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      await page.goto("/settings");
      await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings$/);
      await expect(page.getByTestId("service-accounts-card")).toHaveCount(0);
    } finally {
      await request.delete(`${apiUrl}/auth/users/${encodeURIComponent(username)}`, {
        headers: { authorization: `Basic ${basic}` },
      });
    }
  });
});

function expiredSession(username: string): string {
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    id: `user:${username}`,
    username,
    role: "operator",
    kind: "user",
    exp: 0,
  })}`;
  return `${unsigned}.${createHmac("sha256", sessionSecret).update(unsigned).digest("base64url")}`;
}
