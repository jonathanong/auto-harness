import { expect, test } from "@playwright/test";

test("live primary views guide a first-time operator to their next action", async ({ page }) => {
  const hits = { hosts: 0, sessions: 0, worktrees: 0 };
  await page.route(/\/api\/v1\/(sessions|hosts|worktrees)(?:\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resource = new URL(route.request().url()).pathname.split("/").at(-1) as keyof typeof hits;
    hits[resource] += 1;
    await route.fulfill({
      json: resource === "sessions" ? { items: [], nextCursor: null } : { items: [] },
    });
  });

  await page.goto("/");
  await expect.poll(() => hits.hosts).toBeGreaterThan(0);
  await expect.poll(() => hits.worktrees).toBeGreaterThan(0);
  await expect(page.getByTestId("dashboard-empty-sessions")).toBeVisible();
  await expect(page.getByTestId("dashboard-empty-add-repository")).toHaveAttribute(
    "href",
    "/repositories",
  );
  await expect(page.getByTestId("dashboard-empty-connect-host")).toHaveAttribute("href", "/hosts");
  await expect(page.getByTestId("dashboard-empty-create-session")).toHaveAttribute(
    "href",
    "/sessions/new",
  );
  await expect(page.getByTestId("dashboard-empty-hosts")).toBeVisible();
  await expect(page.getByTestId("dashboard-empty-setup-host")).toHaveAttribute("href", "/hosts");

  const dashboardSessionPolls = hits.sessions;
  await page.goto("/sessions");
  await expect.poll(() => hits.sessions).toBeGreaterThan(dashboardSessionPolls);
  await expect(page.getByTestId("sessions-empty")).toContainText("No sessions yet");
  await page.getByTestId("sessions-empty-create").click();
  await expect(page).toHaveURL(/\/sessions\/new$/);
  await expect(page.getByTestId("form-create-session")).toBeVisible();
});

test("server-rendered empty actions stay wired when the shared catalog is empty", async ({
  page,
}) => {
  await page.goto("/repositories");
  const repositoriesEmpty = page.getByTestId("repositories-empty");
  if (await repositoriesEmpty.isVisible()) {
    await expect(repositoriesEmpty).toContainText("No repositories configured");
    await page.getByTestId("repositories-empty-add").click();
    await expect(page.getByTestId("repositories-empty-dialog")).toBeVisible();
    await expect(
      page.getByTestId("repositories-empty-dialog").getByTestId("form-repo-catalog"),
    ).toBeVisible();
  }

  await page.goto("/schedules");
  const schedulesEmpty = page.getByTestId("schedules-empty");
  if (await schedulesEmpty.isVisible()) {
    await expect(schedulesEmpty).toContainText("No schedules configured");
    await page.getByTestId("schedules-empty-create").click();
    await expect(page).toHaveURL(/\/schedules#schedule-create$/);
    await expect(page.getByTestId("form-create-schedule")).toBeVisible();
  }
});
