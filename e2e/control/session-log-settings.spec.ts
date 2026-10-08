import { expect, test } from "@playwright/test";
import { API_BASE } from "../harness-endpoints.ts";

const settings = {
  uploadMode: "off",
  batchMaxKb: 256,
  batchMaxLines: 500,
  batchMaxWaitMs: 60_000,
  controlPlanePollMs: 60_000,
  sessionRetentionDays: 30,
  version: 0,
};

test.describe("control plane session log settings", () => {
  test("persists a retention change through the form across a reload", async ({
    page,
    request,
  }) => {
    const endpoint = `${API_BASE}/api/v1/session-log-settings`;
    const before = await request.get(endpoint);
    expect(before.ok()).toBe(true);
    const original = await before.json();
    const days = original.sessionRetentionDays === 45 ? 60 : 45;
    try {
      await page.goto("/settings/session-logs");
      await expect(page.getByTestId("session-log-settings-card")).toBeVisible();
      await expect(page.getByTestId("form-session-log-settings")).toBeVisible();
      await expect(page.getByTestId("session-log-upload-mode")).toHaveValue(original.uploadMode);
      await expect(page.getByTestId("session-log-batch-max-kb")).toHaveValue(
        String(original.batchMaxKb),
      );
      await expect(page.getByTestId("session-log-batch-max-lines")).toHaveValue(
        String(original.batchMaxLines),
      );
      await expect(page.getByTestId("session-log-batch-max-wait-ms")).toHaveValue(
        String(original.batchMaxWaitMs),
      );
      await expect(page.getByTestId("session-log-control-plane-poll-ms")).toHaveValue(
        String(original.controlPlanePollMs),
      );
      await expect(page.getByTestId("session-retention-days")).toHaveValue(
        String(original.sessionRetentionDays),
      );
      await page.getByTestId("session-retention-days").fill(String(days));
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/session-log-settings") &&
          response.request().method() === "PUT",
      );
      await page.getByTestId("session-log-settings-save").click();
      expect((await saved).ok()).toBe(true);
      await expect(page.getByTestId("session-log-settings-success")).toBeVisible();
      const persisted = await request.get(endpoint);
      expect(persisted.ok()).toBe(true);
      expect(await persisted.json()).toMatchObject({ sessionRetentionDays: days });
      await page.reload();
      await expect(page.getByTestId("session-retention-days")).toHaveValue(String(days));
    } finally {
      let restored = false;
      for (let attempt = 0; attempt < 3 && !restored; attempt++) {
        const current = await request.get(endpoint);
        expect(current.ok()).toBe(true);
        const { version } = await current.json();
        const response = await request.put(endpoint, {
          data: { version, sessionRetentionDays: original.sessionRetentionDays },
        });
        if (response.status() !== 409) expect(response.ok()).toBe(true);
        restored = response.ok();
      }
      expect(restored, "restore the original retention policy").toBe(true);
    }
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
