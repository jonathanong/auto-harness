/* eslint-disable max-lines -- route authorization, CAS, and audit failure paths share fixtures. */
import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleHostUpdateConfigRoutes } from "./local-routes-host-update-config.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

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
  principal: Principal | undefined = admin,
  method = "PUT",
  path = "/api/v1/hosts/host-1/update-config",
) {
  return await invokeHandler(
    async (req, res) => {
      await handleHostUpdateConfigRoutes({
        plane,
        req,
        res,
        url: new URL(path, "http://localhost"),
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

  it("handles empty, malformed, stale, and missing host records safely", async () => {
    const emptyPlane = new ControlPlane();
    await expect(invoke(emptyPlane, undefined, admin, "GET")).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      invoke(emptyPlane, { updateConfig: { enabled: false } }, admin, "PUT"),
    ).resolves.toMatchObject({
      status: 200,
      json: { version: 1 },
    });
    await expect(
      invoke(emptyPlane, { updateConfig: enabled, version: "bad" }),
    ).resolves.toMatchObject({
      status: 200,
    });
    await expect(invoke(emptyPlane, { updateConfig: enabled, version: 99 })).resolves.toMatchObject(
      {
        status: 409,
      },
    );
    await expect(
      invokeBadJson(
        async (req, res) =>
          handleHostUpdateConfigRoutes({
            plane: emptyPlane,
            req,
            res,
            url: new URL("/api/v1/hosts/host-1/update-config", "http://localhost"),
            method: "PUT",
            principal: admin,
          }),
        "PUT",
        "/api/v1/hosts/host-1/update-config",
      ),
    ).resolves.toBe(400);
  });

  it("supports principals without explicit capability and repository-scoped hiding", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    await expect(invoke(plane, { updateConfig: enabled }, undefined)).resolves.toMatchObject({
      status: 200,
    });
    const scoped: Principal = {
      id: "user:scoped",
      kind: "user",
      role: "viewer",
      allowedRepositoryIds: ["other-repo"],
    };
    await expect(invoke(plane, undefined, scoped, "GET")).resolves.toMatchObject({ status: 404 });
    await expect(invoke(plane, { updateConfig: enabled }, scoped)).resolves.toMatchObject({
      status: 404,
    });
  });

  it("returns false for a neighboring route and maps durable read failures to 500", async () => {
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => {
          throw new Error("storage unavailable");
        },
      } as never,
    });
    await expect(invoke(plane, undefined, admin, "GET")).resolves.toMatchObject({ status: 500 });
    const response = await invokeHandler(
      async (req, res) => {
        const handled = await handleHostUpdateConfigRoutes({
          plane,
          req,
          res,
          url: new URL("/api/v1/hosts/host-1/update", "http://localhost"),
          method: "GET",
          principal: admin,
        });
        if (!handled) {
          (res as unknown as { writeHead(status: number): void }).writeHead(418);
          (res as unknown as { end(): void }).end();
        }
      },
      "GET",
      "/api/v1/hosts/host-1/update",
    );
    expect(response.status).toBe(418);
  });

  it("covers non-PUT dispatch, malformed bodies, CAS failures, and audit fences", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    await expect(invoke(plane, {}, admin)).resolves.toMatchObject({ status: 400 });
    await expect(invoke(plane, enabled, admin, "POST")).resolves.toMatchObject({ status: 0 });

    const failedCas = new ControlPlane();
    (
      failedCas as unknown as { putHostInventoryDurable: () => Promise<unknown> }
    ).putHostInventoryDurable = async () => ({
      ok: false,
      conflict: false,
      error: "invalid update",
    });
    await expect(invoke(failedCas, { updateConfig: enabled })).resolves.toMatchObject({
      status: 400,
    });

    const auditFailure = new ControlPlane();
    (auditFailure as unknown as { appendAuditLog: () => Promise<never> }).appendAuditLog =
      async () => {
        throw new Error("audit unavailable");
      };
    await expect(invoke(auditFailure, { updateConfig: enabled })).resolves.toMatchObject({
      status: 500,
    });

    const outerFailure = new ControlPlane();
    (
      outerFailure as unknown as { getHostInventoryDurable: () => Promise<never> }
    ).getHostInventoryDurable = async () => {
      throw new Error("storage unavailable");
    };
    await expect(invoke(outerFailure, { updateConfig: enabled })).resolves.toMatchObject({
      status: 500,
    });

    const deniedAudit = new ControlPlane();
    (deniedAudit as unknown as { appendAuditLog: () => Promise<never> }).appendAuditLog =
      async () => {
        throw new Error("audit unavailable");
      };
    const boundElsewhere: Principal = {
      id: "agent:other",
      username: "agent",
      role: "viewer",
      kind: "service-account",
      boundHostId: "other-host",
    };
    await expect(
      invoke(deniedAudit, { updateConfig: enabled }, boundElsewhere),
    ).resolves.toMatchObject({
      status: 500,
    });

    const permissionAudit = new ControlPlane();
    permissionAudit.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    await expect(
      invoke(permissionAudit, { updateConfig: enabled }, maintainer),
    ).resolves.toMatchObject({
      status: 500,
    });

    const deniedHost = new ControlPlane();
    await expect(
      invoke(deniedHost, undefined, { ...admin, boundHostId: "other-host" }, "GET"),
    ).resolves.toMatchObject({ status: 404 });

    const failedCasAudit = new ControlPlane();
    expect((await failedCasAudit.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    failedCasAudit.putHostInventoryDurable = async () => ({
      ok: false as const,
      conflict: false as const,
      error: "invalid update",
    });
    failedCasAudit.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    await expect(invoke(failedCasAudit, { updateConfig: enabled })).resolves.toMatchObject({
      status: 500,
    });

    const validationAudit = new ControlPlane();
    validationAudit.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    await expect(
      invoke(validationAudit, { updateConfig: { enabled: false, pollMs: 1 } }),
    ).resolves.toMatchObject({ status: 500 });
  });
});
