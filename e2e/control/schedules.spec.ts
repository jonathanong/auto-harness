import { test, expect } from "@playwright/test";

test.describe("control plane schedules", () => {
  test("schedules page and create form", async ({ page, request }) => {
    const repoId = `pw-sched-repo-${test.info().parallelIndex}-${Date.now()}`;
    const name = `pw-sched-${test.info().parallelIndex}-${Date.now()}`;
    const commandName = `echo-prompt-${test.info().parallelIndex}-${Date.now()}`;
    await request.post("http://127.0.0.1:7430/api/v1/repositories", {
      data: {
        id: repoId,
        name: repoId,
        url: `/tmp/${repoId}`,
        defaultBranch: "main",
      },
    });
    const commandResponse = await request.post("http://127.0.0.1:7430/api/v1/commands", {
      data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
    });
    const commandId = ((await commandResponse.json()) as { id: string }).id;

    await page.goto("/schedules");
    await expect(page.getByTestId("page-schedules")).toBeVisible();
    await expect(page.getByTestId("form-create-schedule")).toBeVisible();
    await page.getByTestId("schedule-repository-id").fill(repoId);
    await page.getByTestId("schedule-name").fill(name);
    await page.getByTestId("schedule-target").selectOption(`command:${commandId}`);
    await page.getByTestId("schedule-cron").fill("0 * * * *");
    await page.getByTestId("schedule-queue-ttl").fill("1234");
    await page.getByTestId("schedule-submit").click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('[data-pw^="schedule-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("1234s");

    const scheduleId = (await row.getAttribute("data-pw"))!.replace("schedule-row-", "");
    await page.getByTestId(`schedule-edit-${scheduleId}`).click();
    await expect(page.getByTestId(`form-edit-schedule-${scheduleId}`)).toBeVisible();
    await page.getByTestId("schedule-queue-ttl").fill("4321");
    await page.getByTestId(`schedule-edit-submit-${scheduleId}`).click();
    await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toContainText("4321s", {
      timeout: 15_000,
    });
  });
});
