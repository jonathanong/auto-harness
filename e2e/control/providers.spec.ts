import { test, expect } from "@playwright/test";

test.describe("control plane providers", () => {
  test("providers page loads with add-provider dialog closed", async ({ page }) => {
    await page.goto("/providers");
    await expect(page.getByTestId("page-providers")).toBeVisible();
    await expect(page.getByTestId("providers-heading")).toHaveText("Providers");
    await expect(page.getByTestId("add-provider-open")).toBeVisible();
    await expect(page.getByTestId("add-provider-dialog")).toBeHidden();
  });

  test("create provider with its default command, then manage accounts/settings", async ({
    page,
  }) => {
    const name = `pw-prov-${test.info().parallelIndex}-${Date.now()}`;
    const commandName = `${name}-print`;
    await page.goto("/providers");
    await page.getByTestId("add-provider-open").click();
    await expect(page.getByTestId("form-provider-catalog")).toBeVisible();
    await page.getByTestId("provider-catalog-name").fill(name);
    await page.getByTestId("provider-catalog-command-name").fill(commandName);
    await page.getByTestId("provider-catalog-argv").fill("claude\n-p");
    await page.getByTestId("provider-catalog-submit").click();

    // One submit creates both the provider and its default command (the footgun guard) —
    // lands on the detail page's Accounts tab.
    await expect(page).toHaveURL(/\/providers\/[^/?]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("provider-detail-id")).toHaveText(name);
    await expect(page.getByTestId("provider-accounts-tab")).toBeVisible();

    await page.getByTestId("provider-account-label").fill(`${name}@example.com`);
    await page.getByTestId("provider-account-submit").click();
    await expect(page.getByText(`${name}@example.com`)).toBeVisible();

    await page.getByTestId("tab-commands").click();
    await expect(page.getByTestId("provider-default-command-select")).toHaveValue(/.+/);
    await expect(page.getByRole("cell", { name: commandName })).toBeVisible();

    await page.getByTestId("tab-settings").click();
    // A provider with accounts/commands still attached can't be deleted (409 deadlock
    // avoidance) — the delete button is disabled rather than left to fail server-side.
    await expect(page.getByTestId("delete-provider-open")).toBeDisabled();
  });

  test("unknown provider id shows a not-found state", async ({ page }) => {
    await page.goto("/providers/does-not-exist-xyz");
    await expect(page.getByTestId("page-provider-detail-not-found")).toBeVisible();
  });
});
