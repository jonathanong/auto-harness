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
    request,
  }) => {
    const name = `pw-prov-${test.info().parallelIndex}-${Date.now()}`;
    const commandName = `${name}-print`;
    await page.goto("/providers");
    await page.getByTestId("add-provider-open").click();
    await expect(page.getByTestId("form-provider-catalog")).toBeVisible();
    await expect(page.getByTestId("provider-catalog-error")).toBeHidden();
    await page.getByTestId("provider-catalog-name").fill(name);
    await page.getByTestId("provider-catalog-command-name").fill(commandName);
    await page.getByTestId("provider-catalog-argv").fill("claude\n-p");
    await expect(page.getByTestId("provider-catalog-append-prompt")).toBeChecked();
    await page.getByTestId("provider-catalog-submit").click();

    // One submit creates both the provider and its default command (the footgun guard) —
    // lands on the detail page's Accounts tab.
    await expect(page).toHaveURL(/\/providers\/[^/?]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("page-provider-detail")).toBeVisible();
    await expect(page.getByTestId("provider-detail-id")).toHaveText(name);
    await expect(page.getByTestId("provider-accounts-tab")).toBeVisible();
    const providerId = new URL(page.url()).pathname.split("/").pop()!;

    await expect(page.getByTestId("form-add-provider-account")).toBeVisible();
    await expect(page.getByTestId("provider-account-error")).toBeHidden();
    await page.getByTestId("provider-account-label").fill(`${name}@example.com`);
    await page.getByTestId("provider-account-cooldown-seconds").fill("1234");
    await page.getByTestId("provider-account-submit").click();
    await expect(page.getByText(`${name}@example.com`)).toBeVisible();
    const accountRow = page.locator('[data-pw^="provider-account-row-"]').first();
    await expect(accountRow).toBeVisible();
    const accountId = (await accountRow.getAttribute("data-pw"))!.replace(
      "provider-account-row-",
      "",
    );
    await expect(page.getByTestId(`provider-account-cooldown-${accountId}`)).toContainText("1234s");
    await expect(page.getByTestId(`provider-account-cooldown-clear-${accountId}`)).toHaveCount(0);
    await expect(
      page.getByTestId(`provider-account-cooldown-clear-error-${accountId}`),
    ).toHaveCount(0);
    await page.getByTestId(`provider-account-cooldown-edit-${accountId}`).click();
    await page.getByTestId(`provider-account-cooldown-input-${accountId}`).fill("4321");
    await page
      .getByTestId(`provider-account-cooldown-form-${accountId}`)
      .getByRole("button", { name: "Save" })
      .click();
    await expect(page.getByTestId(`provider-account-cooldown-${accountId}`)).toContainText(
      "4321s",
      { timeout: 15_000 },
    );

    await page.getByTestId("tab-commands").click();
    await expect(page.getByTestId("provider-commands-tab")).toBeVisible();
    await expect(page.getByTestId("form-provider-default-command")).toBeVisible();
    await expect(page.getByTestId("provider-default-command-error")).toBeHidden();
    await expect(page.getByTestId("provider-default-command-select")).toHaveValue(/.+/);
    await expect(page.getByRole("cell", { name: commandName })).toBeVisible();
    const commandRow = page.locator('[data-pw^="provider-command-row-"]').first();
    await expect(commandRow).toBeVisible();
    const commandId = (await commandRow.getAttribute("data-pw"))!.replace(
      "provider-command-row-",
      "",
    );
    await expect(page.getByTestId(`provider-command-link-${commandId}`)).toBeVisible();

    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("provider-settings")).toBeVisible();
    // A provider with accounts/commands still attached can't be deleted (409 deadlock
    // avoidance) — the delete button is disabled rather than left to fail server-side.
    await expect(page.getByTestId("delete-provider-open")).toBeDisabled();

    // Edit the provider's name, then verify the list page reflects it.
    const renamed = `${name}-renamed`;
    await page.getByTestId("edit-provider-open").click();
    await expect(page.getByTestId("form-edit-provider")).toBeVisible();
    await expect(page.getByTestId("edit-provider-error")).toBeHidden();
    await page.getByTestId("edit-provider-name").fill(renamed);
    await page.getByTestId("edit-provider-submit").click();
    await expect(page.getByTestId("provider-detail-id")).toHaveText(renamed, { timeout: 15_000 });

    await page.goto("/providers");
    await expect(page.getByTestId(`provider-row-${providerId}`)).toBeVisible();
    await expect(page.getByTestId(`provider-link-${providerId}`)).toHaveText(renamed);

    // Remove the account and clear/delete the command so delete-provider becomes enabled,
    // then exercise the confirm flow end to end.
    await page.goto(`/providers/${providerId}`);
    await page.getByTestId(`provider-account-remove-${accountId}`).click();
    await page.getByTestId(`provider-account-remove-${accountId}-confirm-submit`).click();
    await expect(page.getByText(`${name}@example.com`)).toBeHidden({ timeout: 15_000 });

    // deleteCommand only refuses while the command is some provider's default (checked by
    // defaultCommandId, independent of the command's own providerId) — clear that first.
    await page.goto(`/providers/${providerId}?tab=commands`);
    await page.getByTestId("provider-default-command-select").selectOption({ label: "(none)" });
    await page.getByTestId("provider-default-command-submit").click();
    await expect(page.getByTestId("provider-default-command-select")).toHaveValue("", {
      timeout: 15_000,
    });
    await expect
      .poll(async () => {
        const response = await request.get(`http://127.0.0.1:7430/api/v1/providers/${providerId}`);
        return ((await response.json()) as { defaultCommandId: string | null }).defaultCommandId;
      })
      .toBeNull();

    await page.goto(`/commands/${commandId}`);
    await page.getByTestId("delete-command-open").click();
    await page.getByTestId("delete-command-confirm-submit").click();
    await expect(page).toHaveURL(/\/commands$/, { timeout: 15_000 });

    await page.goto(`/providers/${providerId}?tab=settings`);
    await expect(page.getByTestId("delete-provider-open")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("delete-provider-open").click();
    await expect(page.getByTestId("delete-provider-confirm")).toBeVisible();
    await expect(page.getByTestId("delete-provider-error")).toBeHidden();
    await page.getByTestId("delete-provider-confirm-submit").click();
    await expect(page).toHaveURL(/\/providers$/, { timeout: 15_000 });
  });

  test("unknown provider id shows a not-found state", async ({ page }) => {
    await page.goto("/providers/does-not-exist-xyz");
    await expect(page.getByTestId("page-provider-detail-not-found")).toBeVisible();
  });
});
