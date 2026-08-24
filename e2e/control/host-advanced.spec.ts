import { expect, test } from "@playwright/test";

import { API_BASE } from "../harness-endpoints.ts";

test("host setup and validated raw inventory editor preserve conflict semantics", async ({
  page,
  request,
}) => {
  const id = `pw-advanced-host-${test.info().parallelIndex}-${Date.now()}`;
  await request.put(`${API_BASE}/api/v1/hosts/${id}/inventory`, {
    data: { repositories: [], providerAccounts: [] },
  });

  await page.goto(`/hosts/${id}?tab=advanced`);
  await expect(page.getByTestId("form-host-setup-script")).toBeVisible();
  await expect(page.getByTestId("host-exec-config-alert")).toBeVisible();
  await expect(page.getByTestId("host-allowed-roots")).toBeVisible();
  await expect(page.getByTestId("host-required-environment")).toBeVisible();
  await page.getByTestId("host-setup-script").fill("source ~/.zshrc");
  await page.getByTestId("host-setup-script-submit").click();
  await expect(page.getByTestId("host-setup-script-ok")).toHaveText("Saved.", {
    timeout: 15_000,
  });
  expect(
    await (await request.get(`${API_BASE}/api/v1/hosts/${id}/inventory`)).json(),
  ).toMatchObject({ setupScript: "source ~/.zshrc" });

  await expect(page.getByTestId("form-host-config-json")).toBeVisible();
  const content = page.getByRole("textbox", { name: "Host Config JSON" });
  await expect(page.getByTestId("host-config-json").locator(".cm-editor")).toBeVisible();
  await expect(content).toContainText('"repositories"');
  await content.fill("{");
  await expect(page.getByTestId("host-config-json-validation")).not.toHaveText(
    "Valid host inventory JSON",
  );
  await expect(page.getByTestId("host-config-submit")).toBeDisabled();
  await content.fill(
    JSON.stringify(
      { setupScript: "source ~/.zshrc", repositories: [], providerAccounts: [] },
      null,
      2,
    ),
  );
  await expect(page.getByTestId("host-config-json-validation")).toHaveText(
    "Valid host inventory JSON",
  );
  await expect(page.getByTestId("host-config-submit")).toBeEnabled();

  // Land another valid inventory write after the page's read so the editor's version is
  // genuinely stale. Omit exec-config keys so this remains a maintainer-legal inventory PUT.
  await request.put(`${API_BASE}/api/v1/hosts/${id}/inventory`, {
    data: { repositories: [], providerAccounts: [] },
  });
  await page.getByTestId("host-config-submit").click();
  await expect(page.getByTestId("host-config-conflict")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("host-config-conflict")).toContainText(
    "changed since you loaded this page",
  );
  await expect(page.getByTestId("host-config-error")).toHaveCount(0);
  await expect(page.getByTestId("host-config-ok")).toHaveCount(0);

  await page.reload();
  await page.getByTestId("host-config-submit").click();
  await expect(page.getByTestId("host-config-ok")).toHaveText("Saved.", { timeout: 15_000 });
  await expect(page.getByTestId("host-config-conflict")).toHaveCount(0);
});
