import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { admins, auditFixture, basic, invokeRepositoryRoute } from "./audit-test-helpers.ts";

describe("audit authorization outcomes", () => {
  it("records denials and gives audit failures precedence over an HTTP acknowledgement", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({
      name: "scoped",
      role: "admin",
      allowedRepositoryIds: ["repository-a"],
    });
    const plane = auditFixture();
    const { handler } = createLocalApp({ plane, authService: auth });
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          "/api/v1/sessions",
          {
            repositoryId: "repository-b",
            target: { commandId: "command-a" },
            prompt: "safe",
            timeout: 60,
          },
          { authorization: `Bearer ${apiKey}` },
        )
      ).status,
    ).toBe(404);
    for (const metadata of [["invalid"], null, "invalid"]) {
      expect(
        (
          await invokeHandler(
            handler,
            "POST",
            "/api/v1/sessions",
            {
              repositoryId: "repository-a",
              target: { commandId: "command-a" },
              prompt: "safe",
              timeout: 60,
              metadata,
            },
            { authorization: `Bearer ${apiKey}` },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await plane.listAuditLogs({ action: "session:create", outcome: "denied" })).items,
    ).toHaveLength(1);

    for (const [method, path] of [
      ["PATCH", "/api/v1/repositories/repository-a"],
      ["DELETE", "/api/v1/repositories/repository-a"],
    ] as const) {
      const deniedPlane = auditFixture();
      expect(await invokeRepositoryRoute(deniedPlane, method, path, { name: "hidden" })).toBe(404);
      expect(
        (
          await deniedPlane.listAuditLogs({
            action: `repository:${method === "DELETE" ? "delete" : "update"}`,
            outcome: "denied",
          })
        ).items,
      ).toHaveLength(1);
    }

    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          "/api/v1/schedules",
          {
            repositoryId: "repository-a",
            name: "schedule",
            target: { commandId: "command-a" },
            cron: "* * * * *",
            timeout: 60,
            nextRunAt: "2026-08-10T00:00:00.000Z",
            ref: 1,
          },
          basic("root", "root"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(
          handler,
          "PATCH",
          "/api/v1/schedules/schedule-a",
          { ref: 1 },
          basic("root", "root"),
        )
      ).status,
    ).toBe(400);

    const auditFailurePlane = new ControlPlane();
    auditFailurePlane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const missingAuth = createLocalApp({ plane: auditFailurePlane, authService: auth }).handler;
    expect((await invokeHandler(missingAuth, "GET", "/api/v1/repositories")).status).toBe(500);
    const login = createLocalApp({ plane: auditFailurePlane, authMode: "disabled" }).handler;
    expect(
      (await invokeHandler(login, "POST", "/api/v1/auth/login", { username: "x", password: "x" }))
        .status,
    ).toBe(500);
    expect(
      (
        await invokeHandler(
          missingAuth,
          "POST",
          "/api/v1/auth/users",
          { username: "user", password: "pass", role: "operator" },
          basic("root", "root"),
        )
      ).status,
    ).toBe(500);
  });
});
