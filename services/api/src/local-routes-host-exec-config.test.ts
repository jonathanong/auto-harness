/* eslint-disable max-lines -- inventory isolation and exec-config route outcomes share fixtures. */
import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleHostExecConfigRoutes } from "./local-routes-host-exec-config.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

const maintainer: Principal = {
  id: "user:maintainer",
  kind: "user",
  role: "maintainer",
};
const admin: Principal = {
  id: "user:admin",
  kind: "user",
  role: "admin",
};

const inventory = {
  setupScript: "source ~/.zshrc",
  allowedRoots: ["/opt/harness"],
  repositories: [
    {
      id: "repo-1",
      path: "/opt/harness/repo",
      defaultBranch: "main",
      setupScript: "pnpm install",
      terminalHookScript: "/opt/harness/hook.sh",
      worktrees: [
        {
          id: "wt-1",
          name: "wt-1",
          path: "/opt/harness/repo/wt-1",
          labels: [],
          setupScript: "pnpm build",
        },
      ],
    },
  ],
  providerAccounts: [],
};

async function invoke(
  plane: ControlPlane,
  method: string,
  path: string,
  body?: unknown,
  principal?: Principal,
) {
  let handled = true;
  const response = await invokeHandler(
    async (req, res) => {
      handled = path.includes("exec-config")
        ? await handleHostExecConfigRoutes({
            plane,
            req,
            res,
            url: new URL(path, "http://localhost"),
            method,
            ...(principal ? { principal } : {}),
          })
        : await handleHostInventoryRoutes({
            plane,
            req,
            res,
            url: new URL(path, "http://localhost"),
            method,
            ...(principal ? { principal } : {}),
          });
      if (!handled) {
        (res as unknown as { writeHead(status: number): void }).writeHead(418);
        (res as unknown as { end(): void }).end();
      }
    },
    method,
    path,
    body,
  );
  return { ...response, handled };
}

describe("host exec-config isolation", () => {
  it("rejects inventory writes that change setup scripts or executable paths", async () => {
    const plane = new ControlPlane();
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { repositories: [], providerAccounts: [], setupScript: "pwn" },
        maintainer,
      ),
    ).toMatchObject({ status: 403 });
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, setupScript: "pwn" },
        maintainer,
      ),
    ).toMatchObject({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: expect.stringContaining("fleet:exec-config") } },
    });
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        {
          repositories: [
            {
              id: "repo-1",
              path: "/opt/harness/repo-new",
              defaultBranch: "main",
              worktrees: [
                { id: "wt-1", name: "wt-1", path: "/opt/harness/repo-new/wt", labels: ["ci"] },
              ],
            },
          ],
          providerAccounts: [],
        },
        maintainer,
      ),
    ).toMatchObject({ status: 200 });
    const stored = await plane.getHostInventoryDurable("host-1");
    expect(stored?.setupScript).toBe("source ~/.zshrc");
    expect(stored?.allowedRoots).toEqual(["/opt/harness"]);
    expect(stored?.repositories[0]?.path).toBe("/opt/harness/repo-new");
    expect(stored?.repositories[0]?.setupScript).toBe("pnpm install");
    expect(stored?.repositories[0]?.terminalHookScript).toBe("/opt/harness/hook.sh");
    expect(stored?.repositories[0]?.worktrees[0]?.setupScript).toBe("pnpm build");
  });

  it("lets admin inventory writes change exec-config and records both audits", async () => {
    const plane = new ControlPlane();
    const actions: string[] = [];
    const original = plane.appendAuditLog.bind(plane);
    plane.appendAuditLog = async (input) => {
      actions.push(input.action);
      return original(input);
    };
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, setupScript: "echo host" },
        admin,
      ),
    ).toMatchObject({ status: 200 });
    expect(actions).toContain("host-inventory:update");
    expect(actions).toContain("host-exec-config:update");
    expect((await plane.getHostInventoryDurable("host-1"))?.setupScript).toBe("echo host");
  });

  it("updates exec-config through the dedicated route without touching inventory paths", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        {
          setupScript: "echo host",
          allowedRoots: ["/opt/harness", "/usr/local"],
          repositories: [
            {
              id: "repo-1",
              terminalHookScript: "/opt/harness/hooks/other.sh",
              worktrees: [{ id: "wt-1", setupScript: "" }],
            },
          ],
        },
        admin,
      ),
    ).toMatchObject({
      status: 200,
      json: expect.objectContaining({
        setupScript: "echo host",
        allowedRoots: ["/opt/harness", "/usr/local"],
      }),
    });
    const stored = await plane.getHostInventoryDurable("host-1");
    expect(stored?.repositories[0]?.path).toBe("/opt/harness/repo");
    expect(stored?.repositories[0]?.terminalHookScript).toBe("/opt/harness/hooks/other.sh");
    expect(stored?.repositories[0]?.worktrees[0]?.setupScript).toBeUndefined();
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "x" },
        maintainer,
      ),
    ).toMatchObject({ status: 403 });
  });

  it("maps missing hosts, hidden scopes, conflicts, and validation failures", async () => {
    const plane = new ControlPlane();
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/missing/exec-config",
        { setupScript: "echo" },
        admin,
      ),
    ).toMatchObject({
      status: 200,
      json: expect.objectContaining({ setupScript: "echo" }),
    });
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        {},
        {
          ...admin,
          boundHostId: "other",
        },
      ),
    ).toMatchObject({ status: 404 });
    const scoped: Principal = {
      ...admin,
      allowedRepositoryIds: ["missing"],
    };
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: "x" }, scoped),
    ).toMatchObject({ status: 404 });
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { repositories: [{ id: "nope" }] },
        admin,
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: 1 }, admin),
    ).toMatchObject({ status: 400 });
    const failing = new ControlPlane();
    expect((await failing.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    failing.putHostInventoryDurable = async () => ({ ok: false, error: "invalid exec-config" });
    expect(
      await invoke(failing, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: "x" }, admin),
    ).toMatchObject({ status: 400 });
    expect(
      await invoke(plane, "GET", "/api/v1/hosts/host-1/exec-config", undefined, admin),
    ).toMatchObject({ status: 418, handled: false });
    const handler = async (req: never, res: never) =>
      handleHostExecConfigRoutes({
        plane,
        req,
        res,
        url: new URL("/api/v1/hosts/host-1/exec-config", "http://localhost"),
        method: "PUT",
        principal: admin,
      });
    expect(await invokeBadJson(handler, "PUT", "/api/v1/hosts/host-1/exec-config")).toBe(400);

    plane.putHostInventoryDurable = async () => ({
      ok: false as const,
      conflict: true as const,
      error: "host inventory changed since it was read; re-read and retry",
    });
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: "x" }, admin),
    ).toMatchObject({ status: 409 });
  });

  it("fails closed when durable writes or audits throw", async () => {
    const getFail = {
      getHostInventoryDurable: async () => {
        throw new Error("storage failed");
      },
      appendAuditLog: async () => undefined,
    } as unknown as ControlPlane;
    expect(
      await invoke(getFail, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: "x" }, admin),
    ).toMatchObject({ status: 500 });

    const plane = {
      getHostInventoryDurable: async () => inventory,
      putHostInventoryDurable: async () => {
        throw new Error("storage failed");
      },
      appendAuditLog: async () => undefined,
    } as unknown as ControlPlane;
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: "x" }, admin),
    ).toMatchObject({ status: 500 });

    const auditFail = {
      getHostInventoryDurable: async () => inventory,
      putHostInventoryDurable: async () => ({
        ok: true,
        config: { ...inventory, hostId: "host-1" },
      }),
      appendAuditLog: async () => {
        throw new Error("audit unavailable");
      },
    } as unknown as ControlPlane;
    expect(
      await invoke(
        auditFail,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "x" },
        admin,
      ),
    ).toMatchObject({ status: 500 });

    const deniedAudit = {
      getHostInventoryDurable: async () => inventory,
      appendAuditLog: async () => {
        throw new Error("audit unavailable");
      },
    } as unknown as ControlPlane;
    expect(
      await invoke(
        deniedAudit,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "x" },
        {
          ...admin,
          boundHostId: "other",
        },
      ),
    ).toMatchObject({ status: 500 });
    expect(
      await invoke(
        deniedAudit,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "x" },
        maintainer,
      ),
    ).toMatchObject({ status: 500 });
  });
});
