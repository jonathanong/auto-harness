import { expect, test } from "@playwright/test";

test.describe("control-plane keyboard shortcuts", () => {
  test("opens accessible help and restores focus on close", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByTestId("keyboard-shortcuts-trigger");
    await expect(trigger).toHaveAttribute("aria-keyshortcuts", "?");

    await page.keyboard.press("Shift+/");
    const dialog = page.getByTestId("keyboard-shortcuts-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveRole("dialog");
    await expect(dialog).toContainText("Keyboard shortcuts");
    await expect(page.getByTestId("keyboard-shortcut-new-session")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-help")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-d")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-n")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-s")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-r")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-w")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-p")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-c")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-a")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-h")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-go-t")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcut-close")).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("navigates directly and with an announced g prefix", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("g");
    await expect(page.getByTestId("shortcut-sequence-status")).toHaveText(
      "Go to: choose a destination shortcut",
    );
    await page.keyboard.press("s");
    await expect(page).toHaveURL(/\/sessions$/);

    await page.keyboard.press("g");
    await page.keyboard.press("d");
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("n");
    await expect(page).toHaveURL(/\/sessions\/new$/);
  });

  test("suppresses global shortcuts while editing", async ({ page }) => {
    await page.goto("/sessions/new");
    await page.waitForLoadState("networkidle");
    const prompt = page.getByTestId("create-session-prompt");
    await prompt.click();
    await expect(prompt).toBeFocused();
    await prompt.press("n");
    await prompt.press("Shift+/");
    await prompt.press("g");
    await prompt.press("d");
    await expect(page).toHaveURL(/\/sessions\/new$/);
    await expect(page.getByTestId("keyboard-shortcuts-dialog")).toBeHidden();
  });
});
