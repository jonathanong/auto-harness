import { test, expect, type APIRequestContext } from "@playwright/test";

import { withLocalHostLock } from "../local-1-host.ts";
import { API_BASE } from "../harness-endpoints.ts";

async function createPool(request: APIRequestContext, name: string) {
  const response = await request.post(`${API_BASE}/api/v1/workspace-pools`, {
    data: {
      name,
      setupProfiles: [{ id: "ready", name: "Ready", script: "echo ready" }],
      defaultSetupProfileId: "ready",
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string };
}

test.describe("workspace pools", () => {
  test("creates, edits, lists, and deletes trusted pool configuration", async ({ page }) => {
    const name = `pw-workspace-${test.info().parallelIndex}-${Date.now()}`;
    await page.goto("/workspace-pools");
    await expect(page.getByTestId("page-workspace-pools")).toBeVisible();
    await expect(page.getByTestId("workspace-pools-heading")).toHaveText("Workspace pools");
    await expect(page.getByTestId("form-workspace-pool-create")).toBeVisible();
    await page.getByTestId("workspace-pool-name").fill(name);
    await expect(page.getByTestId("workspace-pool-profiles")).toBeVisible();
    await page.getByTestId("workspace-pool-profile-add").click();
    await page.getByTestId("workspace-pool-profile-id-0").fill("ready");
    await page.getByTestId("workspace-pool-profile-name-0").fill("Ready");
    await page.getByTestId("workspace-pool-profile-script-0").fill("echo ready");
    await page.getByTestId("workspace-pool-profile-add").click();
    await page.getByTestId("workspace-pool-profile-remove-1").click();
    await page.getByTestId("workspace-pool-default-profile").selectOption("ready");
    await page.getByTestId("workspace-pool-destroy-after").check();
    await page.getByTestId("workspace-pool-submit").click();

    await expect(page).toHaveURL(/\/workspace-pools\/[^/]+$/, { timeout: 15_000 });
    const poolId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByTestId("page-workspace-pool-detail")).toBeVisible();
    await expect(page.getByTestId("form-workspace-pool-edit")).toBeVisible();
    await page.getByTestId("workspace-pool-destroy-after").uncheck();
    await page.getByTestId("workspace-pool-submit").click();

    await page.goto("/workspace-pools");
    await expect(page.getByTestId(`workspace-pool-row-${poolId}`)).toBeVisible();
    await expect(page.getByTestId(`workspace-pool-link-${poolId}`)).toHaveText(name);
    await page.getByTestId(`workspace-pool-link-${poolId}`).click();
    await expect(page.getByTestId("page-workspace-pool-detail")).toBeVisible();

    let failOnce = true;
    await page.route(`**/api/v1/workspace-pools/${poolId}`, async (route) => {
      if (route.request().method() === "DELETE" && failOnce) {
        failOnce = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "workspace pool is still attached" } }),
        });
        return;
      }
      await route.fallback();
    });
    await page.getByTestId("delete-workspace-pool-open").click();
    await expect(page.getByTestId("delete-workspace-pool-confirm")).toBeVisible();
    await page.getByTestId("delete-workspace-pool-confirm-submit").click();
    await expect(page.getByTestId("delete-workspace-pool-error")).toHaveText(
      "workspace pool is still attached",
    );
    await page.getByTestId("mutation-error-retry").click();
    await expect(page).toHaveURL(/\/workspace-pools$/, { timeout: 15_000 });
  });

  test("shows the workspace-pool not-found state", async ({ page }) => {
    await page.goto("/workspace-pools/does-not-exist");
    await expect(page.getByTestId("page-workspace-pool-not-found")).toBeVisible();
  });

  test("offers only pool and profile identifiers on the workspace session form", async ({
    page,
    request,
  }) => {
    const pool = await createPool(
      request,
      `pw-session-pool-${test.info().parallelIndex}-${Date.now()}`,
    );
    try {
      await page.goto("/sessions/new");
      await expect(page.getByTestId("create-session-mode")).toBeVisible();
      await expect(page.getByTestId("create-session-mode-repository")).toBeChecked();
      await page.getByTestId("create-session-mode-workspace").check();
      await expect(page.getByTestId("create-session-workspace-fields")).toBeVisible();
      await page.getByTestId("create-session-workspace-pool").selectOption(pool.id);
      await page.getByTestId("create-session-workspace-profile").selectOption("ready");
      await page.getByTestId("create-session-workspace-cleanup").selectOption("true");
      await expect(page.getByTestId("create-session-workspace-profile")).toHaveValue("ready");
    } finally {
      await request.delete(`${API_BASE}/api/v1/workspace-pools/${pool.id}`);
    }
  });

  test("attaches a path-only slot to a host", async ({ page, request }) => {
    await withLocalHostLock(async () => {
      const pool = await createPool(
        request,
        `pw-host-pool-${test.info().parallelIndex}-${Date.now()}`,
      );
      const inventoryUrl = `${API_BASE}/api/v1/hosts/local-1/inventory`;
      const originalResponse = await request.get(inventoryUrl);
      const hadInventory = originalResponse.ok();
      const original = hadInventory
        ? ((await originalResponse.json()) as Record<string, unknown>)
        : { repositories: [], providerAccounts: [], version: 0 };
      try {
        const allowedRoots = [
          ...new Set([
            ...(Array.isArray(original.allowedRoots) ? original.allowedRoots : []),
            "/tmp",
          ]),
        ];
        const prepared = await request.put(inventoryUrl, {
          data: { ...original, allowedRoots, workspacePools: [] },
        });
        expect(prepared.ok(), await prepared.text()).toBe(true);
        await page.goto("/hosts/local-1?tab=workspace-pools");
        await expect(page.getByTestId("host-workspace-pools")).toBeVisible();
        await page.getByTestId("host-workspace-pool-select").selectOption(pool.id);
        await page.getByTestId("host-workspace-slot-id").fill("slot-1");
        await page.getByTestId("host-workspace-slot-name").fill("Slot one");
        await page.getByTestId("host-workspace-slot-path").fill("/tmp/workspace-slot-1");
        await expect(page.getByTestId("host-workspace-slot-add")).toBeVisible();
        await page.getByTestId("host-workspace-slot-add-submit").click();
        await expect(
          page.getByTestId(`host-workspace-pool-${pool.id}`).getByLabel("Slot name"),
        ).toHaveValue("Slot one");
      } finally {
        const current = (await (await request.get(inventoryUrl)).json()) as Record<string, unknown>;
        if (hadInventory) {
          await request.put(inventoryUrl, {
            data: {
              ...original,
              version: current.version,
            },
          });
        } else {
          await request.delete(inventoryUrl);
        }
        await request.delete(`${API_BASE}/api/v1/workspace-pools/${pool.id}`);
      }
    });
  });
});
