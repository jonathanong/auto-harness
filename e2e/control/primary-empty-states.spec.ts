import { expect, test } from "@playwright/test";

test("primary views guide a first-time operator to their next action", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-empty-sessions")).toBeVisible();
  await expect(page.getByTestId("dashboard-empty-add-repository")).toHaveAttribute(
    "href",
    "/repositories",
  );
  await expect(page.getByTestId("dashboard-empty-connect-agent")).toHaveAttribute("href", "/hosts");
  await expect(page.getByTestId("dashboard-empty-create-session")).toHaveAttribute(
    "href",
    "/sessions/new",
  );
  await expect(page.getByTestId("dashboard-empty-agents")).toBeVisible();
  await expect(page.getByTestId("dashboard-empty-setup-agent")).toHaveAttribute("href", "/hosts");

  await page.goto("/sessions");
  await expect(page.getByTestId("sessions-empty")).toContainText("No sessions yet");
  await page.getByTestId("sessions-empty-create").click();
  await expect(page).toHaveURL(/\/sessions\/new$/);
  await expect(page.getByTestId("form-create-session")).toBeVisible();

  await page.goto("/repositories");
  await expect(page.getByTestId("repositories-empty")).toContainText("No repositories configured");
  await page.getByTestId("repositories-empty-add").click();
  await expect(page.getByTestId("repositories-empty-dialog")).toBeVisible();
  await expect(
    page.getByTestId("repositories-empty-dialog").getByTestId("form-repo-catalog"),
  ).toBeVisible();

  await page.goto("/schedules");
  await expect(page.getByTestId("schedules-empty")).toContainText("No schedules configured");
  await page.getByTestId("schedules-empty-create").click();
  await expect(page).toHaveURL(/\/schedules#schedule-create$/);
  await expect(page.getByTestId("form-create-schedule")).toBeVisible();
});
