import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { admins, auditFixture } from "./audit-test-helpers.ts";

describe("scoped audited mutations", () => {
  it("does not acknowledge a denied repository or schedule mutation when its denial audit cannot persist", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({
      name: "repository-b-only",
      role: "maintainer",
      allowedRepositoryIds: ["repository-b"],
    });
    const calls = [
      ["PATCH", "/api/v1/repositories/repository-a", { name: "hidden" }],
      ["DELETE", "/api/v1/repositories/repository-a", {}],
      [
        "POST",
        "/api/v1/schedules",
        {
          repositoryId: "repository-a",
          name: "hidden",
          target: { commandId: "command-a" },
          cron: "* * * * *",
          timeout: 60,
        },
      ],
      ["POST", "/api/v1/schedules/schedule-a/trigger", {}],
      ["PATCH", "/api/v1/schedules/schedule-a", { name: "hidden" }],
      ["POST", "/api/v1/sessions/session-a/resume", {}],
    ] as const;

    for (const [method, path, body] of calls) {
      const plane = auditFixture();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authService: auth }).handler,
            method,
            path,
            body,
            { authorization: `Bearer ${apiKey}` },
          )
        ).status,
        path,
      ).toBe(500);
    }
  });
});
