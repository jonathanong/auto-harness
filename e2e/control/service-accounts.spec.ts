import { expect, test } from "@playwright/test";
import { API_BASE } from "../harness-endpoints.ts";

const apiUrl = `${API_BASE}/api/v1`;
const admin = { username: "auth-admin", password: "auth-password" };

test.describe("service-account administration", () => {
  test.skip(process.env.HARNESS_E2E_AUTH !== "1", "requires the dedicated required-auth E2E stack");

  test("admin safely creates, copies, rotates, and revokes service-account keys", async ({
    page,
    request,
    context,
  }) => {
    const basic = Buffer.from(`${admin.username}:${admin.password}`).toString("base64");
    const createdIds: string[] = [];
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/login");
    await page.getByTestId("login-username").fill(admin.username);
    await page.getByTestId("login-password").fill(admin.password);
    await page.getByTestId("login-submit").click();
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("service-accounts-card")).toBeVisible();
    await expect(page.getByTestId("service-accounts-empty")).toBeVisible();
    await expect(page.getByTestId("service-account-role")).toHaveValue("operator");
    await expect(page.getByTestId("service-account-repository-scope")).toContainText(
      "all repositories",
    );

    const name = `pw-service-${test.info().parallelIndex}-${Date.now()}`;
    await page.getByTestId("service-account-name").fill(name);
    await page.getByTestId("service-account-bound-host").fill("pw-host");
    let rejectCreate = true;
    await page.route("**/api/v1/auth/service-accounts", async (route) => {
      if (route.request().method() === "POST" && rejectCreate) {
        rejectCreate = false;
        await route.fulfill({
          status: 503,
          json: { error: { message: "temporary account storage failure" } },
        });
        return;
      }
      await route.fallback();
    });
    await page.getByTestId("service-account-create-submit").click();
    await expect(page.getByTestId("service-account-create-error")).toHaveText(
      "temporary account storage failure",
    );
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/service-accounts") &&
        response.request().method() === "POST",
    );
    await page.getByTestId("service-account-create-submit").click();
    const created = (await (await createResponse).json()) as {
      account: { id: string };
      apiKey: string;
    };
    createdIds.push(created.account.id);
    await expect(page.getByTestId("service-accounts-table")).toBeVisible();
    await expect(page.getByTestId("service-account-key-dialog")).toBeVisible();
    await expect(page.getByTestId("service-account-key-warning")).toContainText("shown once");
    await expect(page.getByTestId("service-account-api-key")).toHaveText(created.apiKey);
    await page.getByTestId("service-account-copy-key").click();
    await expect(page.getByTestId("service-account-copy-ok")).toHaveText("Copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(created.apiKey);
    await page.getByTestId("service-account-key-done").click();
    await expect(page.getByText(created.apiKey, { exact: true })).toHaveCount(0);

    rejectCreate = true;
    await page.getByTestId(`service-account-rotate-${created.account.id}`).click();
    await expect(page.getByTestId(`service-account-rotate-${created.account.id}-error`)).toHaveText(
      "temporary account storage failure",
    );
    const rotateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/service-accounts") &&
        response.request().method() === "POST",
    );
    await page.getByTestId(`service-account-rotate-${created.account.id}`).click();
    const replacement = (await (await rotateResponse).json()) as {
      account: { id: string };
      apiKey: string;
    };
    createdIds.push(replacement.account.id);
    await expect(page.getByTestId("rotation-warning")).toContainText("old key remains active");
    await expect(page.getByTestId("rotation-revoke-old")).toBeDisabled();
    await page.getByTestId("rotation-consumers-updated").check();
    await page.getByTestId("rotation-revoke-old").click();
    await expect(page.getByTestId(`service-account-row-${created.account.id}`)).toHaveCount(0);
    createdIds.shift();
    await page.getByTestId("service-account-key-done").click();
    await page.getByTestId(`service-account-delete-${replacement.account.id}`).click();
    await page
      .getByTestId(`service-account-delete-${replacement.account.id}-confirm-submit`)
      .click();
    await expect(page.getByTestId(`service-account-row-${replacement.account.id}`)).toHaveCount(0);
    createdIds.pop();

    for (const id of createdIds) {
      await request.delete(`${apiUrl}/auth/service-accounts/${encodeURIComponent(id)}`, {
        headers: { authorization: `Basic ${basic}` },
      });
    }
  });

  test("non-admin sessions see the service-account permission boundary", async ({
    page,
    request,
  }) => {
    const username = `pw-no-admin-${test.info().parallelIndex}-${Date.now()}`;
    const basic = Buffer.from(`${admin.username}:${admin.password}`).toString("base64");
    await request.post(`${apiUrl}/auth/users`, {
      headers: { authorization: `Basic ${basic}` },
      data: { username, password: "operator-password", role: "operator" },
    });
    try {
      await page.goto("/login");
      await page.getByTestId("login-username").fill(username);
      await page.getByTestId("login-password").fill("operator-password");
      await page.getByTestId("login-submit").click();
      await page.getByTestId("nav-settings").click();
      await expect(page.getByTestId("service-accounts-forbidden-error")).toContainText(
        "unscoped admin",
      );
      await expect(page.getByTestId("user-accounts-forbidden-error")).toContainText(
        "unscoped admin",
      );
      await expect(page.getByTestId("form-service-account-create")).toHaveCount(0);
      await expect(page.getByTestId("form-user-account-create")).toHaveCount(0);
    } finally {
      await request.delete(`${apiUrl}/auth/users/${encodeURIComponent(username)}`, {
        headers: { authorization: `Basic ${basic}` },
      });
    }
  });
});
