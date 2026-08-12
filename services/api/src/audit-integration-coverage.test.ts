import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { admins, auditFixture, basic } from "./audit-test-helpers.ts";

describe("audit integration coverage", () => {
  it("fails closed when rejected mutation outcomes cannot be audited", async () => {
    const requests = [
      ["POST", "/api/v1/repositories", {}],
      ["PATCH", "/api/v1/repositories/missing", { name: "renamed" }],
      ["DELETE", "/api/v1/repositories/missing", {}],
      [
        "POST",
        "/api/v1/schedules",
        {
          repositoryId: "repository-a",
          name: "invalid-target",
          target: { commandId: "missing" },
          cron: "* * * * *",
          timeout: 60,
        },
      ],
      ["POST", "/api/v1/schedules/missing/trigger", {}],
      ["PATCH", "/api/v1/schedules/schedule-a", { target: { commandId: "missing" } }],
      ["DELETE", "/api/v1/schedules/missing", {}],
      ["POST", "/api/v1/providers", { name: "provider" }],
      ["PATCH", "/api/v1/providers/missing", { name: "provider" }],
      ["DELETE", "/api/v1/providers/missing", {}],
      ["POST", "/api/v1/provider-accounts", { providerId: "missing", label: "account" }],
      ["PATCH", "/api/v1/provider-accounts/missing", { label: "account" }],
      ["DELETE", "/api/v1/provider-accounts/missing", {}],
      ["POST", "/api/v1/commands", { name: "command", argv: [] }],
      ["PATCH", "/api/v1/commands/missing", { name: "command" }],
      ["DELETE", "/api/v1/commands/missing", {}],
    ] as const;

    for (const [method, path, body] of requests) {
      const plane = auditFixture();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      const response = await invokeHandler(
        createLocalApp({ plane, authMode: "disabled" }).handler,
        method,
        path,
        body,
      );
      expect(response.status, path).toBe(500);
    }
  });

  it("fails closed for successful creates and usage-limit outcomes", async () => {
    const creates = [
      ["providerIdFactory", "POST", "/api/v1/providers", { name: "created-provider" }],
      [
        "providerAccountIdFactory",
        "POST",
        "/api/v1/provider-accounts",
        { providerId: "provider-a", label: "created-account" },
      ],
      ["commandIdFactory", "POST", "/api/v1/commands", { name: "created-command", argv: ["tool"] }],
    ] as const;
    for (const [factory, method, path, body] of creates) {
      const plane = auditFixture();
      plane.state[factory] = () => `new-${factory}`;
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authMode: "disabled" }).handler,
            method,
            path,
            body,
          )
        ).status,
        path,
      ).toBe(500);
    }

    for (const id of ["account-a", "missing"]) {
      const plane = auditFixture();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authMode: "disabled" }).handler,
            "DELETE",
            `/api/v1/provider-accounts/${id}/usage-limit`,
          )
        ).status,
      ).toBe(500);
    }
  });

  it("rejects missing cursor records and audits authenticated scheduler work", async () => {
    const plane = auditFixture();
    const missingCursor = Buffer.from(
      JSON.stringify({ id: "missing", createdAt: "2026-08-10T00:00:00.000Z" }),
    ).toString("base64url");
    await expect(plane.listAuditLogs({ cursor: missingCursor })).rejects.toThrow(
      "invalid audit cursor",
    );

    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const handler = createLocalApp({ plane, authService: auth }).handler;
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          "/api/v1/audit-logs?cursor=",
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          `/api/v1/audit-logs?cursor=${"x".repeat(257)}`,
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(200);
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/scheduler/cron", {}, basic("root", "root")))
        .status,
    ).toBe(200);
  });

  it("fails closed for authenticated account and unreferenced catalog deletions", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const user = await auth.createUser({ username: "other", password: "pass", role: "operator" });
    const service = await auth.createServiceAccount({ name: "service", role: "operator" });
    const authPlane = auditFixture();
    authPlane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const authHandler = createLocalApp({ plane: authPlane, authService: auth }).handler;
    const authRequests = [
      ["POST", "/api/v1/auth/login", { username: "root", password: "root" }, {}],
      ["POST", "/api/v1/auth/logout", {}, basic("root", "root")],
      ["DELETE", `/api/v1/auth/users/${user.id}`, {}, basic("root", "root")],
      ["DELETE", `/api/v1/auth/service-accounts/${service.account.id}`, {}, basic("root", "root")],
    ] as const;
    for (const [method, path, body, headers] of authRequests) {
      expect((await invokeHandler(authHandler, method, path, body, headers)).status, path).toBe(
        500,
      );
    }

    for (const resource of ["provider-account", "command", "provider"] as const) {
      const plane = auditFixture();
      if (resource !== "provider-account") {
        plane.state.schedules.clear();
        plane.state.sessions.clear();
      }
      if (resource === "provider") {
        expect(plane.deleteCommand("command-a").ok).toBe(true);
        expect(plane.deleteProviderAccount("account-a").ok).toBe(true);
      }
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      const id = resource === "provider-account" ? "account-a" : `${resource}-a`;
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authMode: "disabled" }).handler,
            "DELETE",
            `/api/v1/${resource}s/${id}`,
          )
        ).status,
      ).toBe(500);
    }
  });
});
