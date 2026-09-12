import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { handleAuditLogRoutes } from "./local-routes-audit-logs.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const admin = { id: "admin", username: "admin", kind: "admin" as const, role: "admin" as const };

describe("audit-log route branch coverage", () => {
  it("leaves unrelated routes for the next handler", async () => {
    const plane = new ControlPlane();

    await expect(
      handleAuditLogRoutes({
        plane,
        req: {} as never,
        res: {} as never,
        url: new URL("/api/v1/not-audit-logs", "http://localhost"),
        method: "GET",
        principal: admin,
      }),
    ).resolves.toBe(false);
  });

  it("does not send omitted audit filters to the control plane", async () => {
    const plane = new ControlPlane();
    const listAuditLogs = vi.fn(async () => ({ items: [], nextCursor: null }));
    plane.listAuditLogs = listAuditLogs;

    const response = await invokeHandler(
      (req, res) =>
        handleAuditLogRoutes({
          plane,
          req: req as never,
          res: res as never,
          url: new URL("/api/v1/audit-logs?limit=5", "http://localhost"),
          method: "GET",
          principal: admin,
        }),
      "GET",
      "/api/v1/audit-logs?limit=5",
    );

    expect(response).toMatchObject({ status: 200, json: { items: [], nextCursor: null } });
    expect(listAuditLogs).toHaveBeenCalledWith({ limit: 5 });
  });
});
