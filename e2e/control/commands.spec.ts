import { test, expect } from "@playwright/test";
import { API_BASE } from "../harness-endpoints.ts";

test.describe("control plane commands", () => {
  test("commands page loads with add-command dialog closed", async ({ page }) => {
    await page.goto("/commands");
    await expect(page.getByTestId("page-commands")).toBeVisible();
    await expect(page.getByTestId("commands-heading")).toHaveText("Commands");
    await expect(page.getByTestId("add-command-open")).toBeVisible();
    await expect(page.getByTestId("add-command-dialog")).toBeHidden();
  });

  test("create standalone command, edit it, assign a provider, then delete with confirm", async ({
    page,
    request,
  }) => {
    const name = `pw-cmd-${test.info().parallelIndex}-${Date.now()}`;
    const providerName = `pw-cmd-prov-${test.info().parallelIndex}-${Date.now()}`;
    await request.post(`${API_BASE}/api/v1/providers`, { data: { name: providerName } });

    await page.goto("/commands");
    await page.getByTestId("add-command-open").click();
    await expect(page.getByTestId("form-command-catalog")).toBeVisible();
    await expect(page.getByTestId("command-catalog-error")).toBeHidden();
    await page.getByTestId("command-catalog-name").fill(name);
    await page.getByTestId("command-catalog-argv").fill("echo");
    await expect(page.getByTestId("command-catalog-append-prompt")).toBeChecked();
    await expect(page.getByTestId("command-catalog-append-prompt-separator")).toBeChecked();
    await page.getByTestId("command-catalog-submit").click();

    await expect(page).toHaveURL(/\/commands\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("page-command-detail")).toBeVisible();
    await expect(page.getByTestId("command-detail-id")).toHaveText(name);
    // Standalone — no provider owns it.
    await expect(page.getByTestId("command-detail-provider")).toHaveText("— (standalone)");
    const commandId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto("/commands");
    await expect(page.getByTestId(`command-row-${commandId}`)).toBeVisible();
    await expect(page.getByTestId(`command-link-${commandId}`)).toHaveText(name);

    await page.goto(`/commands/${commandId}`);
    await page.getByTestId("edit-command-open").click();
    await expect(page.getByTestId("edit-command-dialog")).toBeVisible();
    await expect(page.getByTestId("form-edit-command")).toBeVisible();
    await expect(page.getByTestId("edit-command-error")).toBeHidden();
    await expect(page.getByTestId("edit-command-name")).toHaveValue(name);
    await expect(page.getByTestId("edit-command-append-prompt")).toBeChecked();
    await expect(page.getByTestId("edit-command-append-prompt-separator")).toBeChecked();
    await page.getByTestId("edit-command-argv").fill("echo\n-n");
    await page.getByTestId("edit-command-provider").selectOption({ label: providerName });
    await page.getByTestId("edit-command-submit").click();
    await expect(page.getByTestId("form-edit-command")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("command-detail-argv")).toHaveText("echo -n");
    await expect(page.getByTestId("command-detail-provider")).toHaveText(providerName, {
      timeout: 15_000,
    });

    // Round-trips through the API/DB: re-opening the edit form reflects the persisted value.
    await page.getByTestId("edit-command-open").click();
    await expect(page.getByTestId("edit-command-dialog")).toBeVisible();
    await expect(page.getByTestId("edit-command-append-prompt-separator")).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("edit-command-dialog")).toBeHidden();

    await page.getByTestId("delete-command-open").click();
    await expect(page.getByTestId("delete-command-confirm")).toBeVisible();
    await expect(page.getByTestId("delete-command-error")).toBeHidden();
    await page.getByTestId("delete-command-confirm-submit").click();
    await expect(page).toHaveURL(/\/commands$/, { timeout: 15_000 });

    // Provider-owned command creation, via the picker this time.
    await page.getByTestId("add-command-open").click();
    await page.getByTestId("command-catalog-name").fill(`${name}-owned`);
    await page.getByTestId("command-catalog-argv").fill("echo");
    await page.getByTestId("command-catalog-provider").selectOption({ label: providerName });
    await page.getByTestId("command-catalog-submit").click();
    await expect(page.getByTestId("command-detail-provider")).toHaveText(providerName, {
      timeout: 15_000,
    });
  });

  test("failed command deletion is announced and retryable", async ({ page }) => {
    const name = `pw-cmd-retry-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/commands");
    await page.getByTestId("add-command-open").click();
    await page.getByTestId("command-catalog-name").fill(name);
    await page.getByTestId("command-catalog-argv").fill("echo");
    await page.getByTestId("command-catalog-submit").click();
    await expect(page).toHaveURL(/\/commands\/[^/]+$/, { timeout: 15_000 });
    const commandId = new URL(page.url()).pathname.split("/").pop()!;

    let failDeleteOnce = true;
    await page.route(`**/api/v1/commands/${commandId}`, async (route) => {
      if (route.request().method() === "DELETE" && failDeleteOnce) {
        failDeleteOnce = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "command deletion temporarily unavailable" } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.getByTestId("delete-command-open").click();
    await page.getByTestId("delete-command-confirm-submit").click();
    await expect(page.getByTestId("mutation-error-toast")).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("delete-command-error")).toHaveText(
      "command deletion temporarily unavailable",
    );
    await page.getByTestId("mutation-error-retry").click();
    await expect(page).toHaveURL(/\/commands$/, { timeout: 15_000 });
  });

  test("unknown command id shows a not-found state", async ({ page }) => {
    await page.goto("/commands/does-not-exist-xyz");
    await expect(page.getByTestId("page-command-detail-not-found")).toBeVisible();
  });
});
