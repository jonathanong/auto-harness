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
    await request.post("http://127.0.0.1:7430/api/v1/commands", {
      data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
    });

    await page.goto("/schedules");
    await expect(page.getByTestId("page-schedules")).toBeVisible();
    await expect(page.getByTestId("form-create-schedule")).toBeVisible();
    await page.getByTestId("schedule-repository-id").fill(repoId);
    await page.getByTestId("schedule-name").fill(name);
    await page.getByTestId("schedule-target").selectOption({ label: commandName });
    await page.getByTestId("schedule-cron").fill("0 * * * *");
    await page.getByTestId("schedule-submit").click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
  });
});
