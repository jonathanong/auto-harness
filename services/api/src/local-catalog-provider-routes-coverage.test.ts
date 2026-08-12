import { describe, expect, it } from "vitest";

import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function invoke(plane: ControlPlane, method: string, path: string, body?: unknown) {
  return invokeHandler(createLocalApp({ plane }).handler, method, path, body);
}

function seededPlane(): ControlPlane {
  const plane = new ControlPlane({ now: () => NOW });
  plane.createProvider({ id: "provider", name: "provider" });
  plane.createProvider({ id: "other", name: "other" });
  plane.createProviderAccount({ id: "account", providerId: "provider", label: "account" });
  return plane;
}

describe("local provider catalog route coverage", () => {
  it("classifies provider update validation, conflict, and not-found outcomes", async () => {
    const plane = seededPlane();
    const invalid = await invoke(plane, "PATCH", "/api/v1/providers/provider", { name: "BAD" });
    expect(invalid).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });

    const conflict = await invoke(plane, "PATCH", "/api/v1/providers/provider", { name: "other" });
    expect(conflict).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });

    const missing = await invoke(plane, "PATCH", "/api/v1/providers/missing", { name: "missing" });
    expect(missing).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });

  it("classifies provider account validation and missing updates", async () => {
    const plane = seededPlane();
    const invalid = await invoke(plane, "PATCH", "/api/v1/provider-accounts/account", {
      providerId: "missing",
    });
    expect(invalid).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });

    const missing = await invoke(plane, "PATCH", "/api/v1/provider-accounts/missing", {
      label: "missing",
    });
    expect(missing).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });

  it("maps a conditional provider account update loss to conflict", async () => {
    const plane = new ControlPlane({
      storage: { updateProviderAccount: async () => false } as never,
      now: () => NOW,
    });
    plane.state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    plane.state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 60,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    addDurableReadDefaults(plane.state);

    const response = await invoke(plane, "PATCH", "/api/v1/provider-accounts/account", {
      label: "changed",
    });
    expect(response).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
  });

  it("returns an internal error when the durable cooldown read fails", async () => {
    const plane = new ControlPlane({
      storage: {
        getProviderAccount: async () => {
          throw new Error("storage unavailable");
        },
      } as never,
    });

    const response = await invoke(plane, "DELETE", "/api/v1/provider-accounts/account/usage-limit");
    expect(response).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
  });
});
