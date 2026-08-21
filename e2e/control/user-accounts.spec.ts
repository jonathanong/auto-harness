import { expect, test } from "@playwright/test";
import { API_BASE } from "../harness-endpoints.ts";

const apiUrl = `${API_BASE}/api/v1`;
const admin = { username: "auth-admin", password: "auth-password" };

test.describe("human user-account administration", () => {
  test.skip(process.env.HARNESS_E2E_AUTH !== "1", "requires the dedicated required-auth E2E stack");

  test("admin creates and deletes users without exposing passwords", async ({ page, request }) => {
    const basic = Buffer.from(`${admin.username}:${admin.password}`).toString("base64");
    const username = `pw-human-${test.info().parallelIndex}-${Date.now()}`;
    let created = false;
    try {
      let releaseLoad: (() => void) | undefined;
      await page.route("**/api/v1/auth/users", async (route) => {
        if (route.request().method() === "GET" && !releaseLoad) {
          await new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
          await route.fulfill({ json: { items: [] } });
          return;
        }
        await route.fallback();
      });
      await page.goto("/login");
      await page.getByTestId("login-username").fill(admin.username);
      await page.getByTestId("login-password").fill(admin.password);
      await page.getByTestId("login-submit").click();
      await page.getByTestId("nav-group-settings").click();
      await page.getByTestId("nav-user-accounts").click();
      await expect(page).toHaveURL(/\/settings\/user-accounts/);
      await expect(page.getByTestId("user-accounts-loading")).toBeVisible();
      await expect.poll(() => Boolean(releaseLoad)).toBe(true);
      releaseLoad?.();
      await expect(page.getByTestId("user-accounts-card")).toBeVisible();
      await expect(page.getByTestId("user-accounts-empty")).toBeVisible();
      await expect(page.getByTestId("user-account-password")).toHaveAttribute("type", "password");
      await expect(page.getByTestId("user-account-password")).toHaveAttribute(
        "autocomplete",
        "new-password",
      );
      await expect(page.getByTestId("user-account-role")).toHaveValue("operator");

      await page.getByTestId("user-account-username").fill(username);
      await page.getByTestId("user-account-password").fill("initial-password");
      await page.getByTestId("user-account-role").selectOption("admin");
      let rejectCreate = true;
      await page.route("**/api/v1/auth/users", async (route) => {
        if (route.request().method() === "POST" && rejectCreate) {
          rejectCreate = false;
          await route.fulfill({
            status: 409,
            json: { error: { message: "username already exists" } },
          });
          return;
        }
        await route.fallback();
      });
      await page.getByTestId("user-account-create-submit").click();
      await expect(page.getByTestId("user-account-create-error")).toHaveText(
        "username already exists",
      );
      await expect(page.getByTestId("user-account-password")).toHaveValue("initial-password");

      await page.getByTestId("user-account-create-submit").click();
      created = true;
      await expect(page.getByTestId("user-accounts-table")).toBeVisible();
      const row = page.getByTestId(`user-account-row-${username}`);
      await expect(row).toContainText(username);
      await expect(row).toContainText("admin");
      await expect(row).not.toContainText("initial-password");
      await expect(page.getByTestId("user-account-password")).toHaveValue("");

      let rejectDelete = true;
      await page.route(`**/api/v1/auth/users/${username}`, async (route) => {
        if (route.request().method() === "DELETE" && rejectDelete) {
          rejectDelete = false;
          await route.fulfill({
            status: 503,
            json: { error: { message: "temporary user storage failure" } },
          });
          return;
        }
        await route.fallback();
      });
      await page.getByTestId(`user-account-delete-${username}`).click();
      await page.getByTestId(`user-account-delete-${username}-confirm-submit`).click();
      await expect(page.getByTestId(`user-account-delete-${username}-error`)).toHaveText(
        "temporary user storage failure",
      );
      await page.getByTestId(`user-account-delete-${username}-confirm-submit`).click();
      created = false;
      await expect(row).toHaveCount(0);
      await expect(page.getByTestId("user-accounts-empty")).toBeVisible();
    } finally {
      if (created) {
        await request.delete(`${apiUrl}/auth/users/${encodeURIComponent(username)}`, {
          headers: { authorization: `Basic ${basic}` },
        });
      }
    }
  });

  test("admin sees an accessible user-account load error", async ({ page }) => {
    await page.route("**/api/v1/auth/users", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 503,
          json: { error: { message: "temporary user list failure" } },
        });
        return;
      }
      await route.fallback();
    });
    await page.goto("/login");
    await page.getByTestId("login-username").fill(admin.username);
    await page.getByTestId("login-password").fill(admin.password);
    await page.getByTestId("login-submit").click();
    await page.getByTestId("nav-group-settings").click();
    await page.getByTestId("nav-user-accounts").click();
    await expect(page.getByTestId("user-accounts-error")).toContainText(
      "temporary user list failure",
    );
    await expect(page.getByTestId("user-accounts-error").getByRole("alert")).toBeVisible();
  });
});
