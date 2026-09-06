import { expect, test } from "@playwright/test";

test.describe("control plane user sessions", () => {
  test("lists live browser viewers and the empty and error states", async ({ page }) => {
    await page.route("**/api/v1/user-sessions", async (route) => {
      await route.fulfill({ json: { items: [] } });
    });
    await page.goto("/user-sessions");
    await expect(
      page.getByTestId("page-user-sessions").or(page.getByTestId("user-sessions-loading")).first(),
    ).toBeVisible();
    await expect(page.getByTestId("page-user-sessions")).toBeVisible();
    await expect(page.getByTestId("user-sessions-heading")).toHaveText("User Sessions");
    await expect(page.getByTestId("user-sessions-empty")).toContainText("No live user sessions");
    await expect(page.getByTestId("user-sessions-table")).toHaveCount(0);

    await page.unroute("**/api/v1/user-sessions");
    await page.route("**/api/v1/user-sessions", async (route) => {
      await route.fulfill({
        json: {
          items: [
            {
              id: "viewer-1",
              userId: "user:alice",
              username: "alice",
              role: "operator",
              kind: "user",
              connectedAt: "2026-09-06T00:00:00.000Z",
              lastHeartbeatAt: "2026-09-06T00:01:00.000Z",
              subscriptions: [
                { sessionId: "session-1", repositoryId: "repo-1", status: "running" },
              ],
            },
          ],
        },
      });
    });
    await page.reload();
    await expect(page.getByTestId("user-sessions-table")).toBeVisible();
    await expect(page.getByTestId("user-session-row-viewer-1")).toBeVisible();
    await expect(page.getByTestId("user-session-user-viewer-1")).toHaveText("alice");
    await expect(page.getByTestId("user-session-role-viewer-1")).toHaveText("Operator");
    await expect(page.getByTestId("user-session-connected-viewer-1")).toBeVisible();
    await expect(page.getByTestId("user-session-watching-viewer-1")).toBeVisible();
    await expect(page.getByTestId("user-session-watch-viewer-1-session-1")).toHaveAttribute(
      "href",
      "/sessions/session-1",
    );

    await page.unroute("**/api/v1/user-sessions");
    await page.route("**/api/v1/user-sessions", async (route) => {
      await route.fulfill({ status: 503, json: { error: { code: "INTERNAL_ERROR" } } });
    });
    await page.reload();
    const error = page.getByTestId("user-sessions-api-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Could not load user sessions.");
    await expect(page.getByTestId("user-sessions-table")).toHaveCount(0);
    await expect(page.getByTestId("user-sessions-empty")).toHaveCount(0);
    await page.getByTestId("user-sessions-api-retry").click();
    await expect(error).toBeVisible();
  });
});
