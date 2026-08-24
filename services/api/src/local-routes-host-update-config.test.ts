import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleHostUpdateConfigRoutes } from "./local-routes-host-update-config.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const admin: Principal = { id: "user:admin", kind: "user", role: "admin" };
const maintainer: Principal = { id: "user:maintainer", kind: "user", role: "maintainer" };

const inventory = {
  repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
  providerAccounts: [],
};

const enabled = {
  enabled: true,
  manifestUrl: "https://updates.example.test/manifest.json",
  publicKey: "public key",
  installDir: "/opt/auto-harness",
  pollMs: 60_000,
  daemonVersion: "1.2.3",
};

async function invoke(
  plane: ControlPlane,
  body: unknown,
  principal: Principal = admin,
  method = "PUT",
) {
  return await invokeHandler(
    async (req, res) => {
      await handleHostUpdateConfigRoutes({
        plane,
        req,
        res,
        url: new URL("/api/v1/hosts/host-1/update-config", "http://localhost"),
        method,
        principal,
      });
    },
    method,
    "/api/v1/hosts/host-1/update-config",
    body,
  );
}

describe("host update-config route", () => {
  it("persists typed settings with a CAS fence and records redacted audit metadata", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const version = (await plane.getHostInventoryDurable("host-1"))!.version;
    await expect(invoke(plane, undefined, admin, "GET")).resolves.toMatchObject({
      status: 200,
      json: { version },
    });
    await expect(invoke(plane, { updateConfig: enabled, version })).resolves.toMatchObject({
      status: 200,
      json: { updateConfig: enabled },
    });
    expect((await plane.getHostInventoryDurable("host-1"))?.updateConfig).toEqual(enabled);
    const audit = await plane.listAuditLogs({ action: "host-update-config:update" });
    expect(audit.items).toMatchObject([
      { outcome: "success", metadata: { changed: ["updateConfig"] } },
    ]);
    expect(JSON.stringify(audit.items)).not.toContain("public key");
    await expect(
      invoke(plane, { updateConfig: { enabled: false }, version }),
    ).resolves.toMatchObject({
      status: 409,
    });
  });

  it("requires exec-config authority and rejects unsafe configuration", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    await expect(invoke(plane, { updateConfig: enabled }, maintainer)).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      invoke(plane, { updateConfig: { ...enabled, installDir: "relative" } }),
    ).resolves.toMatchObject({ status: 400 });
    expect((await plane.getHostInventoryDurable("host-1"))?.updateConfig).toBeUndefined();
    expect(
      (await plane.listAuditLogs({ action: "host-update-config:update", outcome: "failed" })).items,
    ).toHaveLength(1);
  });
});
