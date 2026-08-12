import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { auditFixture } from "./audit-test-helpers.ts";

describe("audited mutation route coverage", () => {
  it("accepts the optional mutation inputs that are persisted in audit-protected routes", async () => {
    const plane = auditFixture();
    const { handler } = createLocalApp({ plane, authMode: "disabled" });
    const calls = [
      [
        "POST",
        "/api/v1/repositories",
        {
          name: "optional-repository",
          url: "https://example.test/optional.git",
          defaultBranch: "main",
          setupScript: "setup",
          terminalHookScript: "hook",
        },
        400,
      ],
      ["POST", "/api/v1/repositories", {}, 400],
      ["PATCH", "/api/v1/repositories/repository-a", {}, 200],
      [
        "PATCH",
        "/api/v1/repositories/repository-a",
        {
          name: "renamed-repository",
          url: "https://example.test/renamed.git",
          defaultBranch: "release",
          setupScript: "updated setup",
          terminalHookScript: "updated hook",
        },
        200,
      ],
      [
        "POST",
        "/api/v1/schedules",
        {
          id: "schedule-optional",
          repositoryId: "repository-a",
          name: "optional-schedule",
          target: { commandId: "command-a" },
          fallbacks: [],
          cron: "* * * * *",
          timeout: 60,
          queueTtlSeconds: 120,
          nextRunAt: "2026-08-10T00:00:00.000Z",
          enabled: true,
          ref: "main",
          concurrencyId: "optional-concurrency",
        },
        201,
      ],
      [
        "PATCH",
        "/api/v1/schedules/schedule-a",
        {
          name: "updated-schedule",
          target: { commandId: "command-a" },
          fallbacks: [],
          cron: "*/2 * * * *",
          timeout: 90,
          queueTtlSeconds: 180,
          nextRunAt: "2026-08-10T01:00:00.000Z",
          enabled: false,
          ref: "main",
          repositoryId: "repository-a",
          concurrencyId: "updated-concurrency",
        },
        200,
      ],
      ["POST", "/api/v1/providers", { name: "optional-provider", defaultCommandId: null }, 400],
      ["PATCH", "/api/v1/providers/provider-a", { name: "provider", defaultCommandId: null }, 200],
      [
        "POST",
        "/api/v1/provider-accounts",
        { providerId: "provider-a", label: "optional-account", usageLimitCooldownSeconds: 60 },
        400,
      ],
      [
        "PATCH",
        "/api/v1/provider-accounts/account-a",
        { providerId: "provider-a", label: "updated-account", usageLimitCooldownSeconds: 120 },
        200,
      ],
      ["POST", "/api/v1/commands", { name: "optional-command", argv: ["tool"] }, 400],
      [
        "PATCH",
        "/api/v1/commands/command-a",
        { name: "updated-command", argv: ["tool", "x"] },
        200,
      ],
      [
        "POST",
        "/api/v1/sessions",
        {
          repositoryId: "repository-a",
          target: { commandId: "command-a" },
          prompt: "audited metadata",
          timeout: 60,
          metadata: { requestId: "request-a" },
        },
        201,
      ],
    ] as const;

    for (const [method, path, body, status] of calls) {
      expect((await invokeHandler(handler, method, path, body)).status, path).toBe(status);
    }
  });

  it("makes representative success-path acknowledgements fail closed when audit persistence fails", async () => {
    const calls = [
      ["DELETE", "/api/v1/schedules/schedule-a", {}],
      ["POST", "/api/v1/providers", { name: "audit-failure-provider", defaultCommandId: null }],
      [
        "POST",
        "/api/v1/provider-accounts",
        { providerId: "provider-a", label: "audit-failure-account", usageLimitCooldownSeconds: 60 },
      ],
      ["POST", "/api/v1/commands", { name: "audit-failure-command", argv: ["tool"] }],
    ] as const;

    for (const [method, path, body] of calls) {
      const plane = auditFixture();
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
  });

  it("fails closed for resume validation and successful resumption acknowledgements", async () => {
    for (const body of [[], { unexpected: true }] as const) {
      const plane = auditFixture();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authMode: "disabled" }).handler,
            "POST",
            "/api/v1/sessions/session-a/resume",
            body,
          )
        ).status,
      ).toBe(500);
    }

    const plane = auditFixture();
    expect(plane.cancelSession("session-a").ok).toBe(true);
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane, authMode: "disabled" }).handler,
          "POST",
          "/api/v1/sessions/session-a/resume",
        )
      ).status,
    ).toBe(500);
  });
});
