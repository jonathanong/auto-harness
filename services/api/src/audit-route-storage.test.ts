import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { admins, basic } from "./audit-test-helpers.ts";

describe("audit storage and host outcomes", () => {
  it("pages typed audit storage and audits host-message outcomes", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const record = await new ControlPlane({
      storage: {
        putAuditLog: async () => undefined,
        listAuditLogs: async () => ({
          items: [
            {
              id: "storage-audit",
              actor: { id: "system", kind: "system", role: "system" },
              action: "storage:list",
              resourceType: "audit",
              resourceId: "one",
              outcome: "success",
              metadata: {},
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ],
        }),
      } as never,
    }).listAuditLogs({ action: "storage:list" });
    expect(record.items).toMatchObject([{ id: "storage-audit" }]);
    await expect(
      new ControlPlane().listAuditLogs({
        cursor: Buffer.from(JSON.stringify({ id: 1, createdAt: "x" })).toString("base64url"),
      }),
    ).rejects.toThrow("invalid audit cursor");

    const failed = new ControlPlane();
    failed.handleHostMessageDurable = async () => ({ ok: false, error: "host rejected" }) as never;
    const failedHandler = createLocalApp({ plane: failed, authMode: "disabled" }).handler;
    const register = {
      type: "host:register",
      hostId: "host-a",
      worktrees: [],
      commandProfiles: [],
    };
    expect(
      (await invokeHandler(failedHandler, "POST", "/api/v1/host/messages", register)).status,
    ).toBe(400);
    expect(
      (await failed.listAuditLogs({ action: "host:message", outcome: "failed" })).items,
    ).toHaveLength(1);

    const succeeded = new ControlPlane();
    succeeded.handleHostMessageDurable = async () => ({ ok: true }) as never;
    const succeededHandler = createLocalApp({ plane: succeeded, authMode: "disabled" }).handler;
    expect(
      (await invokeHandler(succeededHandler, "POST", "/api/v1/host/messages", register)).status,
    ).toBe(200);
    expect(
      (await succeeded.listAuditLogs({ action: "host:message", outcome: "success" })).items,
    ).toHaveLength(1);

    const auditLogPlane = new ControlPlane();
    const auditLogHandler = createLocalApp({ plane: auditLogPlane, authService: auth }).handler;
    expect(
      (
        await invokeHandler(
          auditLogHandler,
          "GET",
          "/api/v1/audit-logs?resourceType=session&repositoryId=repository-a",
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(200);
    auditLogPlane.listAuditLogs = async () => {
      throw new Error("list unavailable");
    };
    expect(
      (
        await invokeHandler(
          auditLogHandler,
          "GET",
          "/api/v1/audit-logs",
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(500);
  });
});
