import { test, expect } from "@playwright/test";

const API = "http://127.0.0.1:7430";

test.describe("control plane host provider accounts", () => {
  test("attach an account with a command override, then change, clear, and detach it", async ({
    page,
    request,
  }) => {
    const hostId = `pw-hostprov-${test.info().parallelIndex}-${Date.now()}`;
    const providerName = `pw-prov-${test.info().parallelIndex}-${Date.now()}`;
    const accountLabel = `${providerName}@example.com`;

    const provider = await (
      await request.post(`${API}/api/v1/providers`, { data: { name: providerName } })
    ).json();
    const defaultCommand = await (
      await request.post(`${API}/api/v1/commands`, {
        data: {
          name: `${providerName}-default`,
          argv: ["echo", "default"],
          providerId: provider.id,
        },
      })
    ).json();
    await request.patch(`${API}/api/v1/providers/${provider.id}`, {
      data: { defaultCommandId: defaultCommand.id },
    });
    await request.post(`${API}/api/v1/commands`, {
      data: { name: `${providerName}-alt`, argv: ["echo", "alt"], providerId: provider.id },
    });
    const account = await (
      await request.post(`${API}/api/v1/provider-accounts`, {
        data: { providerId: provider.id, label: accountLabel },
      })
    ).json();

    await page.goto("/hosts");
    await page.getByTestId("add-host-id").fill(hostId);
    await page.getByTestId("add-host-submit").click();
    await expect(page.getByTestId("add-host-ok")).toBeVisible({ timeout: 15_000 });

    await page.goto(`/hosts/${hostId}?tab=provider-accounts`);
    await expect(page.getByTestId("host-provider-accounts-section")).toBeVisible();
    await expect(page.getByTestId("form-attach-provider-account")).toBeVisible();
    await page
      .getByTestId("attach-provider-account-select")
      .selectOption({ label: `${providerName} — ${accountLabel}` });
    await page.getByTestId("attach-provider-account-submit").click();

    const row = page.getByTestId(`host-provider-account-row-${account.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`host-provider-account-command-form-${account.id}`),
    ).toBeVisible();
    // No override yet — effective command falls back to the provider default.
    await expect(row).toContainText(`${providerName}-default`);

    // Set an explicit override, confirm the effective command follows it.
    await page
      .getByTestId(`host-provider-account-command-select-${account.id}`)
      .selectOption({ label: `${providerName}-alt` });
    await page.getByTestId(`host-provider-account-command-submit-${account.id}`).click();
    await expect(row).toContainText(`${providerName}-alt`, { timeout: 15_000 });

    // Clear it back to inherit — falls back to the provider default again.
    await page
      .getByTestId(`host-provider-account-command-select-${account.id}`)
      .selectOption({ label: "(inherit provider default)" });
    await page.getByTestId(`host-provider-account-command-submit-${account.id}`).click();
    await expect(row).toContainText(`${providerName}-default`, { timeout: 15_000 });

    // Detach with confirm.
    await page.getByTestId(`host-provider-account-remove-${account.id}`).click();
    await expect(
      page.getByTestId(`host-provider-account-remove-${account.id}-confirm`),
    ).toBeVisible();
    await page.getByTestId(`host-provider-account-remove-${account.id}-confirm-submit`).click();
    await expect(row).toBeHidden({ timeout: 15_000 });
  });
});
