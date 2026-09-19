import { expect, test } from "@playwright/test";

import { runSmokeCli, setupSmokeFixture } from "./cli-host-smoke-helpers.ts";
import { API_BASE } from "../harness-endpoints.ts";

const API = API_BASE;

test.setTimeout(120_000);

test.describe("cli host smoke", () => {
  test("a real echo-backed provider passes end to end and teardown leaves no trace", async ({
    request,
  }) => {
    const fixture = await setupSmokeFixture(request, "echo", ["echo"]);
    try {
      const result = await runSmokeCli(fixture, request, "echo");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok, result.stderr).toBe(true);
      expect(parsed.providers).toHaveLength(1);
      expect(parsed.providers[0].pass).toBe(true);
      expect(parsed.teardown.ok).toBe(true);
      expect(result.status).toBe(0);

      const reposRes = await request.get(`${API}/api/v1/repositories`);
      const { items } = (await reposRes.json()) as { items: Array<{ id: string }> };
      expect(items.some((repo) => repo.id === parsed.repositoryId)).toBe(false);

      // Attach/detach must round-trip providerAccounts untouched.
      const inventoryRes = await request.get(`${API}/api/v1/hosts/${fixture.hostId}/inventory`);
      const inventory = await inventoryRes.json();
      expect(inventory.repositories).toEqual([]);
      expect(inventory.providerAccounts).toEqual([{ providerAccountId: fixture.accountId }]);
    } finally {
      fixture.cleanupTempDir();
    }
  });

  test("a failing command fails the provider, exits 1, and still tears down the repository", async ({
    request,
  }) => {
    const fixture = await setupSmokeFixture(request, "false", ["false"]);
    try {
      const result = await runSmokeCli(fixture, request, "false");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.providers[0].pass).toBe(false);
      expect(parsed.teardown.ok, result.stderr).toBe(true);
      expect(result.status).toBe(1);

      const reposRes = await request.get(`${API}/api/v1/repositories`);
      const { items } = (await reposRes.json()) as { items: Array<{ id: string }> };
      expect(items.some((repo) => repo.id === parsed.repositoryId)).toBe(false);
    } finally {
      fixture.cleanupTempDir();
    }
  });
});
