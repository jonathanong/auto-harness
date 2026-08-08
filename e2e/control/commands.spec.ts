import { test, expect } from "@playwright/test";

test.describe("control plane commands", () => {
  test("commands page loads with add-command dialog closed", async ({ page }) => {
    await page.goto("/commands");
    await expect(page.getByTestId("page-commands")).toBeVisible();
    await expect(page.getByTestId("commands-heading")).toHaveText("Commands");
    await expect(page.getByTestId("add-command-open")).toBeVisible();
    await expect(page.getByTestId("add-command-dialog")).toBeHidden();
  });

  test("create standalone command, edit it, then delete with confirm", async ({ page }) => {
    const name = `pw-cmd-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/commands");
    await page.getByTestId("add-command-open").click();
    await expect(page.getByTestId("form-command-catalog")).toBeVisible();
    await page.getByTestId("command-catalog-name").fill(name);
    await page.getByTestId("command-catalog-argv").fill("echo");
    await page.getByTestId("command-catalog-submit").click();

    await expect(page).toHaveURL(/\/commands\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("command-detail-id")).toHaveText(name);
    // Standalone — no provider owns it.
    await expect(page.getByTestId("command-detail-provider")).toHaveText("— (standalone)");

    await page.getByTestId("edit-command-open").click();
    await expect(page.getByTestId("form-edit-command")).toBeVisible();
    await page.getByTestId("edit-command-argv").fill("echo\n-n");
    await page.getByTestId("edit-command-submit").click();
    await expect(page.getByTestId("command-detail-argv")).toHaveText("echo -n");

    await page.getByTestId("delete-command-open").click();
    await expect(page.getByTestId("delete-command-confirm")).toBeVisible();
    await page.getByTestId("delete-command-confirm-submit").click();
    await expect(page).toHaveURL(/\/commands$/, { timeout: 15_000 });
  });

  test("unknown command id shows a not-found state", async ({ page }) => {
    await page.goto("/commands/does-not-exist-xyz");
    await expect(page.getByTestId("page-command-detail-not-found")).toBeVisible();
  });
});
