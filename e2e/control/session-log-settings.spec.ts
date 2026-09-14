import { expect, test } from "@playwright/test";

const settings = {
  uploadMode: "off",
  batchMaxKb: 256,
  batchMaxLines: 500,
  batchMaxWaitMs: 60_000,
  controlPlanePollMs: 60_000,
  version: 0,
};

test.describe("control plane session log settings", () => {
  test("loads knobs and saves an upload-mode change", async ({ page }) => {
    let saved: Record<string, unknown> | undefined;
    await page.route("**/api/v1/session-log-settings", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({ status: 200, json: settings });
        return;
      }
      if (method === "PUT") {
        saved = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          json: { ...settings, uploadMode: "always", version: 1 },
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/settings/session-logs");
    await expect(page.getByTestId("session-log-settings-card")).toBeVisible();
    await expect(page.getByTestId("form-session-log-settings")).toBeVisible();
    await expect(page.getByTestId("session-log-upload-mode")).toHaveValue("off");
    await expect(page.getByTestId("session-log-batch-max-kb")).toHaveValue("256");
    await expect(page.getByTestId("session-log-batch-max-lines")).toHaveValue("500");
    await expect(page.getByTestId("session-log-batch-max-wait-ms")).toHaveValue("60000");
    await expect(page.getByTestId("session-log-control-plane-poll-ms")).toHaveValue("60000");
    await page.getByTestId("session-log-upload-mode").selectOption("always");
    await page.getByTestId("session-log-settings-save").click();
    await expect(page.getByTestId("session-log-settings-success")).toBeVisible();
    expect(saved).toMatchObject({ version: 0, uploadMode: "always" });
  });

  test("shows loading until settings resolve", async ({ page }) => {
    let release: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/session-log-settings", async (route) => {
      await pending;
      await route.fulfill({ status: 200, json: settings });
    });

    await page.goto("/settings/session-logs");
    await expect(page.getByTestId("session-log-settings-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    release!();
    await expect(page.getByTestId("session-log-settings-card")).toBeVisible();
  });

  test("shows a forbidden state", async ({ page }) => {
    await page.route("**/api/v1/session-log-settings", (route) =>
      route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN" } } }),
    );
    await page.goto("/settings/session-logs");
    await expect(page.getByTestId("session-log-settings-forbidden")).toBeVisible();
    await expect(page.getByTestId("session-log-settings-forbidden-error")).toBeVisible();
  });

  test("shows a load error", async ({ page }) => {
    await page.route("**/api/v1/session-log-settings", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL" } } }),
    );
    await page.goto("/settings/session-logs");
    await expect(page.getByTestId("session-log-settings-error")).toBeVisible();
    await expect(page.getByTestId("session-log-settings-load-error")).toBeVisible();
  });
});
