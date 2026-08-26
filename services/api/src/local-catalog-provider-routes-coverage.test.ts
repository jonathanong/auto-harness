/* eslint-disable max-lines -- provider catalog route coverage shares one fixture. */
import { describe, expect, it } from "vitest";

import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { AuthService } from "./auth.ts";
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
  it("hides and protects lease holders outside the principal's repository scope", async () => {
    const plane = seededPlane();
    for (const [slot, repositoryId] of [
      [0, "allowed"],
      [1, "hidden"],
    ] as const) {
      const attemptId = `attempt-${String(slot)}`;
      const concurrencyId = `provider-lease:account:${String(slot)}`;
      const sessionId = `session-${String(slot)}`;
      plane.state.sessions.set(sessionId, {
        id: sessionId,
        repositoryId,
        status: "cancelled",
        attemptId,
        providerAccountLease: { concurrencyId, providerAccountId: "account", slot, attemptId },
      } as never);
      plane.state.providerAccountLeases.set(concurrencyId, {
        concurrencyId,
        providerAccountId: "account",
        slot,
        sessionId,
        attemptId,
      });
    }
    const auth = new AuthService({
      mode: "required",
      secret: "s".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "admin", password: "password" }])).toString(
        "base64url",
      ),
    });
    const { apiKey } = await auth.createServiceAccount({
      name: "scoped operator",
      role: "operator",
      allowedRepositoryIds: ["allowed"],
    });
    const handler = createLocalApp({ plane, authService: auth }).handler;
    const headers = { authorization: `Bearer ${apiKey}` };

    const listed = await invokeHandler(
      handler,
      "GET",
      "/api/v1/provider-accounts/account/leases",
      undefined,
      headers,
    );
    expect(listed).toMatchObject({
      status: 200,
      json: { items: [{ slot: 0, holder: { sessionId: "session-0" } }] },
    });
    expect(listed.raw).not.toContain("session-1");
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/provider-accounts/account/leases/1/release",
        undefined,
        headers,
      ),
    ).toMatchObject({ status: 404 });
    expect(plane.state.sessions.get("session-1")).toHaveProperty("providerAccountLease");
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/provider-accounts/account/leases/0/release",
        undefined,
        headers,
      ),
    ).toMatchObject({ status: 200, json: { released: true } });
  });

  it("lists legacy occupied slots and force-releases only a terminal exact lease", async () => {
    const plane = seededPlane();
    const lease = {
      concurrencyId: "provider-lease:account:7",
      providerAccountId: "account",
      slot: 7,
      attemptId: "attempt",
    };
    plane.state.sessions.set("session", {
      id: "session",
      repositoryId: "repository",
      prompt: "prompt",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: NOW,
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "cancelled",
      queueShard: 0,
      createdAt: NOW,
      startedAt: NOW,
      hostId: "host",
      attemptId: "attempt",
      providerAccountLease: lease,
    });
    const listed = await invoke(plane, "GET", "/api/v1/provider-accounts/account/leases");
    expect(listed).toMatchObject({
      status: 200,
      json: {
        items: [
          {
            providerAccountId: "account",
            slot: 7,
            holder: {
              sessionId: "session",
              attemptId: "attempt",
              hostId: "host",
              sessionStatus: "cancelled",
              sessionCreatedAt: NOW,
              sessionStartedAt: NOW,
              releasable: true,
              releaseBlock: null,
            },
          },
        ],
      },
    });
    const released = await invoke(
      plane,
      "POST",
      "/api/v1/provider-accounts/account/leases/7/release",
    );
    expect(released).toMatchObject({
      status: 200,
      json: {
        released: true,
        before: { slot: 7, holder: { sessionId: "session" } },
        after: { slot: 7, holder: null },
      },
    });
    expect(plane.state.sessions.get("session")).not.toHaveProperty("providerAccountLease");
    expect(
      await invoke(plane, "POST", "/api/v1/provider-accounts/account/leases/7/release"),
    ).toMatchObject({
      status: 200,
      json: { released: false, before: { holder: null }, after: { holder: null } },
    });
  });

  it("rejects invalid, active, and missing provider-account lease releases", async () => {
    const plane = seededPlane();
    expect(
      await invoke(plane, "POST", "/api/v1/provider-accounts/account/leases/64/release"),
    ).toMatchObject({ status: 400 });
    expect(
      await invoke(plane, "POST", "/api/v1/provider-accounts/account/leases/nope/release"),
    ).toMatchObject({ status: 400 });
    plane.state.sessions.set("active", {
      id: "active",
      repositoryId: "repository",
      prompt: "prompt",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: NOW,
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: NOW,
      attemptId: "attempt",
      providerAccountLease: {
        concurrencyId: "provider-lease:account:0",
        providerAccountId: "account",
        slot: 0,
        attemptId: "attempt",
      },
    });
    expect(
      await invoke(plane, "POST", "/api/v1/provider-accounts/account/leases/0/release"),
    ).toMatchObject({ status: 409 });
    expect(await invoke(plane, "GET", "/api/v1/provider-accounts/missing/leases")).toMatchObject({
      status: 404,
    });
    expect(
      await invoke(plane, "POST", "/api/v1/provider-accounts/missing/leases/0/release"),
    ).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });

  it("fails closed when lease release outcome audits cannot be stored", async () => {
    for (const path of [
      "/api/v1/provider-accounts/account/leases/nope/release",
      "/api/v1/provider-accounts/account/leases/64/release",
      "/api/v1/provider-accounts/account/leases/1/release",
    ]) {
      const plane = seededPlane();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      expect((await invoke(plane, "POST", path)).status, path).toBe(500);
    }

    const conflicted = seededPlane();
    conflicted.state.providerAccountLeases.set("provider-lease:account:0", {
      providerAccountId: "account",
      concurrencyId: "provider-lease:account:0",
      slot: 0,
      sessionId: "missing-session",
      attemptId: "attempt",
      hostId: "host",
    });
    conflicted.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      await invoke(conflicted, "POST", "/api/v1/provider-accounts/account/leases/0/release"),
    ).toMatchObject({ status: 500 });

    for (const auditFails of [false, true]) {
      const failed = seededPlane();
      failed.forceReleaseProviderAccountLeaseDurable = async () => {
        throw new Error("storage unavailable");
      };
      if (auditFails) {
        failed.appendAuditLog = async () => {
          throw new Error("audit unavailable");
        };
      }
      expect(
        await invoke(failed, "POST", "/api/v1/provider-accounts/account/leases/0/release"),
      ).toMatchObject({ status: 500 });
    }
  });

  it("maps a provider-account lease listing failure to an internal error", async () => {
    const plane = seededPlane();
    plane.listProviderAccountLeaseStatesDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect(await invoke(plane, "GET", "/api/v1/provider-accounts/account/leases")).toMatchObject({
      status: 500,
    });
  });

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

  it("rejects non-numeric provider-account caps rather than treating them as absent", async () => {
    const plane = seededPlane();
    for (const maxConcurrentSessions of [null, "2"] as const) {
      const response = await invoke(plane, "PATCH", "/api/v1/provider-accounts/account", {
        maxConcurrentSessions,
      });
      expect(response).toMatchObject({
        status: 400,
        json: {
          error: {
            code: "VALIDATION_ERROR",
            message: expect.stringContaining("maxConcurrentSessions"),
          },
        },
      });
    }
    expect(plane.getProviderAccount("account")?.maxConcurrentSessions).toBe(1);
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
      maxConcurrentSessions: 1,
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

  it("requests assignment after a provider move or cap increase", async () => {
    const plane = seededPlane();
    const calls: string[] = [];
    plane.requestAssignment = async () => {
      calls.push("assign");
    };
    expect(
      (await invoke(plane, "PATCH", "/api/v1/provider-accounts/account", { label: "renamed" }))
        .status,
    ).toBe(200);
    expect(calls).toEqual([]);
    expect(
      (await invoke(plane, "PATCH", "/api/v1/provider-accounts/account", { providerId: "other" }))
        .status,
    ).toBe(200);
    expect(calls).toEqual(["assign"]);
    expect(
      (
        await invoke(plane, "PATCH", "/api/v1/provider-accounts/account", {
          maxConcurrentSessions: 2,
        })
      ).status,
    ).toBe(200);
    expect(calls).toEqual(["assign", "assign"]);
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

  it("maps provider-account delete conflicts, dependencies, and missing rows", async () => {
    for (const result of [
      { ok: false, conflict: true, error: "in use", dependencies: { hosts: ["host"] } },
      { ok: false, conflict: false, error: "missing" },
    ] as const) {
      const plane = seededPlane();
      plane.deleteProviderAccountDurable = async () => result as never;
      const response = await invoke(plane, "DELETE", "/api/v1/provider-accounts/account");
      expect(response.status).toBe(result.conflict ? 409 : 404);
      expect(response.json).toMatchObject({
        error: { code: result.conflict ? "CONFLICT" : "NOT_FOUND" },
      });
    }
  });
});
