import { test, expect } from "@playwright/test";

test.describe("control plane schedules", () => {
  test("schedules page and create form", async ({ page, request }) => {
    const repoId = `pw-sched-repo-${test.info().parallelIndex}-${Date.now()}`;
    const name = `pw-sched-${test.info().parallelIndex}-${Date.now()}`;
    const commandName = `echo-prompt-${test.info().parallelIndex}-${Date.now()}`;
    await request.post("/api/v1/repositories", {
      data: {
        id: repoId,
        name: repoId,
        url: `/tmp/${repoId}`,
        defaultBranch: "main",
      },
    });
    const commandResponse = await request.post("/api/v1/commands", {
      data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
    });
    const commandId = ((await commandResponse.json()) as { id: string }).id;

    await page.goto("/schedules");
    await expect(page.getByTestId("page-schedules")).toBeVisible();
    await expect(page.getByTestId("schedules-heading")).toHaveText("Schedules");
    await expect(page.getByTestId("form-create-schedule")).toBeVisible();
    await expect(page.getByTestId("schedule-error")).toBeHidden();
    await page.getByTestId("schedule-repository-id").fill(repoId);
    await page.getByTestId("schedule-name").fill(name);
    await page.getByTestId("schedule-target").selectOption(`command:${commandId}`);
    await page.getByTestId("schedule-cron").fill("0 * * * *");
    await page.getByTestId("schedule-queue-ttl").fill("1234");
    await page.getByTestId("schedule-concurrency-id").fill(`${repoId}-${name}`);
    await page.getByTestId("schedule-submit").click();
    await expect(page).toHaveURL(/\/schedules\/[^/?]+/, { timeout: 15_000 });
    await expect(page.getByTestId("page-schedule-detail")).toBeVisible();
    await expect(page.getByTestId("schedule-detail-name")).toHaveText(name);
    await expect(page.getByTestId("form-edit-schedule")).toBeVisible();
    await expect(page.getByTestId("edit-schedule-queue-ttl")).toHaveValue("1234");
    const detailUrl = page.url();
    await expect(page.getByTestId("schedule-history-table")).toContainText("No runs yet.");
    await expect(page.getByTestId("edit-schedule-repository-id")).toHaveValue(repoId);
    await expect(page.getByTestId("edit-schedule-name")).toHaveValue(name);
    await expect(page.getByTestId("edit-schedule-cron")).toHaveValue("0 * * * *");
    await expect(page.getByTestId("edit-schedule-timeout")).toHaveValue("600");
    await expect(page.getByTestId("edit-schedule-concurrency-id")).toHaveValue(`${repoId}-${name}`);
    await expect(page.getByTestId("edit-schedule-enabled")).toBeChecked();
    await page.getByTestId("edit-schedule-cron").fill("30 * * * *");
    await page.getByTestId("edit-schedule-ref").fill("main");
    await page.getByTestId("edit-schedule-submit").click();
    await expect(page.getByTestId("edit-schedule-submit")).toBeEnabled();
    await expect(page.getByTestId("edit-schedule-error")).toBeHidden();
    const detailScheduleId = detailUrl.split("/").pop()!;
    const updated = await request.get(`/api/v1/schedules/${detailScheduleId}`);
    expect(await updated.json()).toMatchObject({
      cron: "30 * * * *",
      nextRunAt: expect.stringMatching(/:30:00\.000Z$/),
    });
    await page.reload();
    await expect(page.getByTestId("edit-schedule-cron")).toHaveValue("30 * * * *");
    await expect(page.getByTestId("edit-schedule-ref")).toHaveValue("main");

    await page.getByRole("button", { name: "Trigger" }).click();
    await expect(page).toHaveURL(/\/sessions\/[^/?]+/);
    await page.goto(detailUrl);
    await expect(page.getByTestId("schedule-detail-active-session")).toBeVisible();
    await expect(page.getByTestId("schedule-history-table").getByRole("row")).toHaveCount(2);

    await page.goto(`/schedules/not-found-${Date.now()}`);
    await expect(page.getByTestId("page-schedule-detail-not-found")).toBeVisible();

    // Verify provider-fallback fields survive the create/detail flow and remain editable.
    await page.goto("/schedules");
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('[data-pw^="schedule-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("1234s");
    const scheduleId = (await row.getAttribute("data-pw"))!.replace("schedule-row-", "");
    await expect(page.getByTestId(`schedule-route-${scheduleId}`)).toBeVisible();
    const enabled = page.getByTestId(`schedule-enabled-${scheduleId}`);
    await expect(enabled).toHaveAttribute("role", "switch");
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await enabled.click();
    await expect(page.getByTestId(`schedule-enabled-${scheduleId}`)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(await (await request.get(`/api/v1/schedules/${scheduleId}`)).json()).toMatchObject({
      enabled: false,
    });
    const cron = page.getByTestId(`schedule-cron-${scheduleId}`);
    await expect(cron).toHaveText("Every hour at minute 30");
    await expect(cron).toHaveAttribute("title", "Cron: 30 * * * *");
    await expect(cron).toHaveAttribute(
      "aria-label",
      "Every hour at minute 30. Cron expression: 30 * * * *",
    );
    await page.getByTestId(`schedule-edit-${scheduleId}`).click();
    await expect(page.getByTestId(`form-edit-schedule-${scheduleId}`)).toBeVisible();
    await page.getByTestId("schedule-queue-ttl").fill("4321");
    await page.getByTestId(`schedule-edit-submit-${scheduleId}`).click();
    await expect(page).toHaveURL(/\/schedules\/[^/?]+/, { timeout: 15_000 });
    await page.goto("/schedules");
    await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toContainText("4321s", {
      timeout: 15_000,
    });
  });
});
