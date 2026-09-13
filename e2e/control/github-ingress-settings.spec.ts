import { expect, test } from "@playwright/test";

test.describe("control plane GitHub ingress settings", () => {
  test("creates and deletes the singleton ingress configuration", async ({ page }) => {
    let configured = false;
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/v1/integrations/github-ingress", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill(
          configured
            ? { status: 200, json: { enabled: true, bindings: [] } }
            : { status: 404, json: { error: { code: "NOT_FOUND" } } },
        );
        return;
      }
      if (method === "POST") {
        configured = true;
        submitted = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          json: { version: 1, generation: "generation-1" },
        });
        return;
      }
      configured = false;
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/settings/github-ingress");
    await expect(page.getByTestId("github-ingress-settings-card")).toBeVisible();
    await expect(page.getByTestId("github-ingress-enabled")).toBeChecked();
    await expect(page.getByTestId("github-ingress-add-binding")).toBeVisible();
    await page.getByTestId("github-ingress-secret").fill("a-high-entropy-webhook-secret");
    await page.getByRole("textbox", { name: "GitHub repository id" }).fill("42");
    await page.getByRole("textbox", { name: "Auto Harness repository id" }).fill("repo-1");
    await page.getByRole("textbox", { name: "Target id" }).fill("provider-1");
    await page.getByTestId("github-ingress-add-fallback-0").click();
    await page.getByTestId("github-ingress-fallback-type-0-0").selectOption("commandId");
    await page.getByTestId("github-ingress-fallback-id-0-0").fill("team,provider");
    await page.getByTestId("github-ingress-save").click();

    await expect(page.getByTestId("github-ingress-success")).toContainText("saved");
    expect(submitted).toMatchObject({
      secret: "a-high-entropy-webhook-secret",
      enabled: true,
      bindings: [
        expect.objectContaining({
          githubRepositoryId: 42,
          repositoryId: "repo-1",
          target: { providerId: "provider-1" },
          fallbacks: [{ commandId: "team,provider" }],
        }),
      ],
    });
    await page.getByTestId("github-ingress-delete").click();
    await expect(page.getByTestId("github-ingress-delete-confirm")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("github-ingress-delete-confirm")).toBeHidden();
    await page.getByTestId("github-ingress-delete").click();
    await page.getByTestId("github-ingress-delete-confirm-submit").click();
    await expect(page.getByTestId("github-ingress-success")).toContainText("deleted");
  });
});
