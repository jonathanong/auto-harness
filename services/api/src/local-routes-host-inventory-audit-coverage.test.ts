import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const scoped: Principal = {
  id: "service:host-1",
  kind: "service-account",
  role: "operator",
  boundHostId: "host-1",
  allowedRepositoryIds: ["repo-allowed"],
};
const inventory = {
  repositories: [{ id: "repo-allowed", path: "/allowed", defaultBranch: "main", worktrees: [] }],
  commandProfiles: {},
};

describe("host inventory audit failures", () => {
  it("fails closed for denied, rejected, successful, and deleted writes", async () => {
    expect(
      await invoke(
        auditFailingPlane(),
        "DELETE",
        "/api/v1/hosts/host-2/inventory",
        undefined,
        scoped,
      ),
    ).toBe(500);
    expect(
      await invoke(
        auditFailingPlane({
          putHostInventoryDurable: async () => ({ ok: false, error: "invalid inventory" }),
        }),
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { repositories: [], commandProfiles: {} },
      ),
    ).toBe(500);
    expect(
      await invoke(auditFailingPlane(), "PUT", "/api/v1/hosts/host-1/inventory", inventory),
    ).toBe(500);
    expect(await invoke(auditFailingPlane(), "DELETE", "/api/v1/hosts/missing/inventory")).toBe(
      500,
    );

    const existing = auditFailingPlane();
    expect(await existing.putHostInventoryDurable("host-1", inventory)).toMatchObject({ ok: true });
    expect(await invoke(existing, "DELETE", "/api/v1/hosts/host-1/inventory")).toBe(500);
    expect(
      await invoke(auditFailingPlane(), "DELETE", "/api/v1/hosts/host-1/inventory", undefined, {
        id: "user:scoped",
        kind: "user",
        role: "maintainer",
        allowedRepositoryIds: ["repo-allowed"],
      }),
    ).toBe(500);
  });
});

async function failure(): Promise<never> {
  throw new Error("audit unavailable");
}

function auditFailingPlane(overrides: Partial<ControlPlane> = {}): ControlPlane {
  return Object.assign(new ControlPlane(), overrides, { appendAuditLog: failure });
}

async function invoke(
  plane: ControlPlane,
  method: string,
  path: string,
  body?: unknown,
  principal?: Principal,
): Promise<number> {
  const response = await invokeHandler(
    async (req, res) => {
      await handleHostInventoryRoutes({
        plane,
        req,
        res,
        url: new URL(path, "http://localhost"),
        method,
        ...(principal ? { principal } : {}),
      });
    },
    method,
    path,
    body,
  );
  return response.status;
}
