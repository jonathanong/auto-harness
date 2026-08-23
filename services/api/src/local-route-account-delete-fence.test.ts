import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const now = "2026-08-23T00:00:00.000Z";

function durableReferences() {
  return {
    listSchedules: async () => [],
    listAllSessions: async () => [],
    listSessionDrains: async () => [],
    listAllWorktrees: async () => [],
    listHostInventories: async () => [],
    listProviders: async () => [],
    listProviderAccounts: async () => [],
    listCommands: async () => [],
    putAuditLog: async () => undefined,
  };
}

describe("durable account deletion fencing", () => {
  it("owns the principal marker through the dependency read and account delete", async () => {
    let activeOwner: string | undefined;
    const released: string[] = [];
    const storage = {
      ...durableReferences(),
      acquireDeletionMarker: async (key: string, owner: string) => {
        expect(key).toBe("principal:user:alice");
        activeOwner = owner;
        return true;
      },
      releaseDeletionMarker: async (key: string, owner: string) => {
        expect(owner).toBe(activeOwner);
        activeOwner = undefined;
        released.push(key);
      },
      deleteAuthAccountFenced: async (
        id: string,
        fence: { key: string; owner: string; now: string },
      ) => {
        expect(id).toBe("user:alice");
        expect(fence).toEqual({ key: "principal:user:alice", owner: activeOwner, now });
        return "deleted" as const;
      },
    };
    const plane = new ControlPlane({ storage: storage as never, now: () => now });
    const auth = new AuthService({ mode: "disabled" });
    await auth.createUser({ username: "alice", password: "password", role: "operator" });
    const { handler } = createLocalApp({ plane, authService: auth });

    const response = await invokeHandler(handler, "DELETE", "/api/v1/auth/users/alice");

    expect(response.status).toBe(204);
    expect(auth.listUsers()).toEqual([]);
    expect(released).toEqual(["principal:user:alice"]);
  });

  it("keeps the account when its principal marker is already busy", async () => {
    const storage = {
      ...durableReferences(),
      acquireDeletionMarker: async () => false,
      releaseDeletionMarker: async () => undefined,
    };
    const plane = new ControlPlane({ storage: storage as never, now: () => now });
    const auth = new AuthService({ mode: "disabled" });
    await auth.createUser({ username: "alice", password: "password", role: "operator" });
    const { handler } = createLocalApp({ plane, authService: auth });

    const response = await invokeHandler(handler, "DELETE", "/api/v1/auth/users/alice");

    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: { code: "CONFLICT" } });
    expect(auth.listUsers()).toHaveLength(1);
  });

  it("reports a durable fence loss without evicting a service account", async () => {
    const storage = {
      ...durableReferences(),
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => undefined,
      deleteAuthAccountFenced: async () => "fence-lost" as const,
    };
    const plane = new ControlPlane({ storage: storage as never, now: () => now });
    const auth = new AuthService({ mode: "disabled" });
    const { account } = await auth.createServiceAccount({ name: "service", role: "operator" });
    const { handler } = createLocalApp({ plane, authService: auth });

    const response = await invokeHandler(
      handler,
      "DELETE",
      `/api/v1/auth/service-accounts/${account.id}`,
    );

    expect(response).toMatchObject({
      status: 409,
      json: {
        error: {
          code: "CONFLICT",
          message: "catalog deletion lease was lost; retry the request",
        },
      },
    });
    expect(auth.listServiceAccounts()).toHaveLength(1);
  });
});
