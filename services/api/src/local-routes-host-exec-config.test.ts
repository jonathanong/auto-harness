/* eslint-disable max-lines -- inventory isolation and exec-config route outcomes share fixtures. */
import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import type { HostInventoryRecord } from "./db/plane-storage.ts";
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
  it("acknowledges the committed exec-config when projection persistence fails afterward", async () => {
    const inventories = new Map<string, HostInventoryRecord>();
    const worktrees = new Map<string, import("./db/types.ts").WorktreeRecord>();
    const audits: Array<{ action: string; outcome?: string }> = [];
    let failProjection = false;
    const storage = {
      putAuditLog: async (record: { action: string; outcome?: string }) => {
        audits.push(record);
      },
      listAuditLogs: async () => ({ items: [] }),
      putHostInventory: async (record: HostInventoryRecord) => {
        inventories.set(record.hostId, { ...record });
        return true;
      },
      getHostInventory: async (hostId: string) => inventories.get(hostId) ?? null,
      listHostInventories: async () => [...inventories.values()],
      listAllWorktrees: async () => [...worktrees.values()],
      putWorktree: async (record: import("./db/types.ts").WorktreeRecord) => {
        if (failProjection) throw new Error("projection unavailable");
        worktrees.set(record.id, { ...record });
      },
      deleteWorktree: async (id: string) => {
        if (failProjection) throw new Error("projection unavailable");
        worktrees.delete(id);
      },
    } as never;
    const plane = new ControlPlane({ storage });
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    await plane.settleStorage();
    failProjection = true;

    await expect(
      invoke(plane, "PUT", "/api/v1/hosts/host-1/exec-config", { setupScript: "new setup" }, admin),
    ).resolves.toMatchObject({ status: 200 });
    expect((await plane.getHostInventoryDurable("host-1"))?.setupScript).toBe("new setup");
    expect(
      audits.some(
        (record) => record.action === "host-exec-config:update" && record.outcome === "success",
      ),
    ).toBe(true);
    expect(
      audits.some(
        (record) => record.action === "host-exec-config:update" && record.outcome === "failed",
      ),
    ).toBe(false);
    await expect(plane.settleStorage()).rejects.toThrow("projection unavailable");
  });

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
    ).toMatchObject({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: expect.stringContaining("fleet:exec-config") } },
    });
    const stored = await plane.getHostInventoryDurable("host-1");
    expect(stored?.setupScript).toBe("source ~/.zshrc");
    expect(stored?.allowedRoots).toEqual(["/opt/harness"]);
    expect(stored?.repositories[0]?.path).toBe("/opt/harness/repo");
    expect(stored?.repositories[0]?.setupScript).toBe("pnpm install");
    expect(stored?.repositories[0]?.terminalHookScript).toBe("/opt/harness/hook.sh");
    expect(stored?.repositories[0]?.worktrees[0]?.setupScript).toBe("pnpm build");
  });

  it("blocks inventory deletion that would erase exec-config without the capability", async () => {
    const plane = new ControlPlane();
    const execAudits: Array<{ outcome?: string; metadata?: unknown }> = [];
    const originalAudit = plane.appendAuditLog.bind(plane);
    plane.appendAuditLog = async (input) => {
      if (input.action === "host-exec-config:update") {
        execAudits.push({ outcome: input.outcome, metadata: input.metadata });
      }
      return originalAudit(input);
    };
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(plane, "DELETE", "/api/v1/hosts/host-1/inventory", undefined, maintainer),
    ).toMatchObject({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: expect.stringContaining("fleet:exec-config") } },
    });
    expect(await plane.getHostInventoryDurable("host-1")).toMatchObject({
      setupScript: "source ~/.zshrc",
    });
    expect(
      await invoke(plane, "DELETE", "/api/v1/hosts/host-1/inventory", undefined, admin),
    ).toMatchObject({ status: 204 });
    expect(execAudits).toContainEqual({
      outcome: "success",
      metadata: {
        changed: [
          "setupScript",
          "allowedRoots",
          "repositories.repo-1.setupScript",
          "repositories.repo-1.terminalHookScript",
          "repositories.repo-1.worktrees.wt-1.setupScript",
        ],
      },
    });
    expect(await plane.getHostInventoryDurable("host-1")).toBeNull();
    expect(
      (
        await plane.putHostInventoryDurable("host-plain", {
          repositories: [],
          providerAccounts: [],
        })
      ).ok,
    ).toBe(true);
    expect(
      await invoke(plane, "DELETE", "/api/v1/hosts/host-plain/inventory", undefined, maintainer),
    ).toMatchObject({ status: 204 });
    expect((await plane.putHostInventoryDurable("host-open", inventory)).ok).toBe(true);
    expect(await invoke(plane, "DELETE", "/api/v1/hosts/host-open/inventory")).toMatchObject({
      status: 204,
    });
  });

  it("treats removal of exec-config-bearing repositories and worktrees as privileged edits", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { repositories: [], providerAccounts: [] },
        maintainer,
      ),
    ).toMatchObject({ status: 403 });
    expect(await plane.getHostInventoryDurable("host-1")).toMatchObject({
      repositories: [expect.objectContaining({ terminalHookScript: "/opt/harness/hook.sh" })],
    });
  });

  it("treats a blank worktree override as a privileged deletion and stores inheritance", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const body = {
      ...inventory,
      repositories: [
        {
          ...inventory.repositories[0]!,
          worktrees: [{ ...inventory.repositories[0]!.worktrees[0]!, setupScript: "" }],
        },
      ],
    };
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/inventory", body, maintainer),
    ).toMatchObject({ status: 403 });
    expect(await invoke(plane, "PUT", "/api/v1/hosts/host-1/inventory", body, admin)).toMatchObject(
      { status: 200 },
    );
    const stored = await plane.getHostInventoryDurable("host-1");
    expect(stored).toMatchObject({ repositories: [{ worktrees: [{ id: "wt-1" }] }] });
    expect(Object.hasOwn(stored?.repositories[0]?.worktrees[0] ?? {}, "setupScript")).toBe(false);
  });

  it("preserves an explicit empty allowed-roots inventory value and unchanged legacy hooks", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, allowedRoots: [] },
        admin,
      ),
    ).toMatchObject({ status: 200 });
    expect((await plane.getHostInventoryDurable("host-1"))?.allowedRoots).toEqual([]);

    const legacy = {
      hostId: "host-legacy",
      ...inventory,
      repositories: [
        {
          ...inventory.repositories[0]!,
          id: "repo-legacy",
          terminalHookScript: "./hook.sh",
          worktrees: [
            {
              ...inventory.repositories[0]!.worktrees[0]!,
              id: "wt-legacy",
              name: "wt-legacy",
            },
          ],
        },
      ],
      updatedAt: "2026-08-23T00:00:00.000Z",
      version: 1,
    };
    plane.state.hostInventories.set("host-legacy", legacy);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-legacy/inventory",
        {
          ...legacy,
          repositories: [{ ...legacy.repositories[0]!, path: "/opt/harness/renamed" }],
        },
        admin,
      ),
    ).toMatchObject({ status: 200 });
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-legacy/inventory",
        {
          ...legacy,
          repositories: [{ ...legacy.repositories[0]!, terminalHookScript: "./changed.sh" }],
        },
        admin,
      ),
    ).toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR", message: expect.stringContaining("absolute") } },
    });
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

  it("writes the exec-config audit before an inventory commit and records a failed CAS", async () => {
    const plane = new ControlPlane();
    const events: Array<{ action: string; outcome?: string }> = [];
    const originalAudit = plane.appendAuditLog.bind(plane);
    plane.appendAuditLog = async (input) => {
      events.push({ action: input.action, outcome: input.outcome });
      return await originalAudit(input);
    };
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const originalPut = plane.putHostInventoryDurable.bind(plane);
    plane.putHostInventoryDurable = async (...args) => {
      expect(events).toContainEqual({ action: "host-exec-config:update", outcome: "success" });
      return await originalPut(...args);
    };
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, setupScript: "echo audited" },
        admin,
      ),
    ).toMatchObject({ status: 200 });

    plane.putHostInventoryDurable = async () => ({
      ok: false as const,
      conflict: true as const,
      error: "host inventory changed since it was read; re-read and retry",
    });
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, setupScript: "echo conflict" },
        admin,
      ),
    ).toMatchObject({ status: 409 });
    expect(events).toContainEqual({ action: "host-exec-config:update", outcome: "failed" });
  });

  it("fails closed before an inventory exec-config change when its audit cannot persist", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const originalAudit = plane.appendAuditLog.bind(plane);
    plane.appendAuditLog = async (input) => {
      if (input.action === "host-exec-config:update" && input.outcome === "success") {
        throw new Error("audit unavailable");
      }
      return await originalAudit(input);
    };
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, setupScript: "must not commit" },
        admin,
      ),
    ).toMatchObject({ status: 500 });
    expect((await plane.getHostInventoryDurable("host-1"))?.setupScript).toBe("source ~/.zshrc");
  });

  it("preserves omitted exec-config on capable inventory PUTs", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
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
        admin,
      ),
    ).toMatchObject({ status: 200 });
    const stored = await plane.getHostInventoryDurable("host-1");
    expect(stored?.setupScript).toBe("source ~/.zshrc");
    expect(stored?.allowedRoots).toEqual(["/opt/harness"]);
    expect(stored?.repositories[0]?.path).toBe("/opt/harness/repo-new");
    expect(stored?.repositories[0]?.setupScript).toBe("pnpm install");
    expect(stored?.repositories[0]?.terminalHookScript).toBe("/opt/harness/hook.sh");
    expect(stored?.repositories[0]?.worktrees[0]?.setupScript).toBe("pnpm build");
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/inventory", {
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
      }),
    ).toMatchObject({ status: 200 });
    expect((await plane.getHostInventoryDurable("host-1"))?.allowedRoots).toEqual(["/opt/harness"]);
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
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        {
          repositories: [
            {
              id: "repo-1",
              path: "/opt/harness/repo",
              defaultBranch: "main",
              terminalHookScript: "hooks/done.sh",
              worktrees: [],
            },
          ],
          providerAccounts: [],
        },
        admin,
      ),
    ).toMatchObject({
      status: 400,
      json: { error: { message: expect.stringContaining("absolute path") } },
    });
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

  it("uses the server-read version for versionless inventory and exec-config writes", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const version = (await plane.getHostInventoryDurable("host-1"))?.version;
    const bodies: Array<Record<string, unknown>> = [];
    plane.putHostInventoryDurable = async (_hostId, body) => {
      bodies.push(body as Record<string, unknown>);
      return {
        ok: false as const,
        conflict: true as const,
        error: "host inventory changed since it was read; re-read and retry",
      };
    };
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, repositories: [] },
        admin,
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "echo versioned" },
        admin,
      ),
    ).toMatchObject({ status: 409 });
    expect(bodies.map((body) => body.version)).toEqual([version, version]);

    for (const invalidVersion of [null, -1, 1.5, "1"]) {
      expect(
        await invoke(
          plane,
          "PUT",
          "/api/v1/hosts/host-1/exec-config",
          { setupScript: "echo versioned", version: invalidVersion },
          admin,
        ),
      ).toMatchObject({ status: 409 });
    }
    expect(bodies.slice(2).map((body) => body.version)).toEqual([
      version,
      version,
      version,
      version,
    ]);
  });

  it("fails closed when validation, CAS, or outer error audits cannot persist", async () => {
    const invalidAudit = new ControlPlane();
    (invalidAudit as unknown as { appendAuditLog: () => Promise<never> }).appendAuditLog =
      async () => {
        throw new Error("audit unavailable");
      };
    expect(
      await invoke(
        invalidAudit,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: 1 },
        admin,
      ),
    ).toMatchObject({ status: 500 });

    const casAudit = new ControlPlane();
    expect((await casAudit.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    casAudit.putHostInventoryDurable = async () => ({
      ok: false as const,
      conflict: false as const,
      error: "invalid exec-config",
    });
    (casAudit as unknown as { appendAuditLog: () => Promise<never> }).appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      await invoke(
        casAudit,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "x" },
        admin,
      ),
    ).toMatchObject({ status: 500 });

    const outerAudit = new ControlPlane();
    (
      outerAudit as unknown as { getHostInventoryDurable: () => Promise<never> }
    ).getHostInventoryDurable = async () => {
      throw new Error("storage unavailable");
    };
    (outerAudit as unknown as { appendAuditLog: () => Promise<never> }).appendAuditLog =
      async () => {
        throw new Error("audit unavailable");
      };
    expect(
      await invoke(
        outerAudit,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "x" },
        admin,
      ),
    ).toMatchObject({ status: 500 });

    const unmatched = await invokeHandler(
      async (req, res) => {
        const handled = await handleHostExecConfigRoutes({
          plane: new ControlPlane(),
          req,
          res,
          url: new URL("/api/v1/hosts/host-1/exec-config-extra", "http://localhost"),
          method: "PUT",
          principal: admin,
        });
        if (!handled) {
          (res as unknown as { writeHead(status: number): void }).writeHead(418);
          (res as unknown as { end(): void }).end();
        }
      },
      "PUT",
      "/api/v1/hosts/host-1/exec-config-extra",
      { setupScript: "x" },
    );
    expect(unmatched.status).toBe(418);
  });

  it("accepts an explicit nonnegative version for a valid exec-config patch", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const version = (await plane.getHostInventoryDurable("host-1"))?.version;
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "echo version", version },
        admin,
      ),
    ).toMatchObject({ status: 200 });
  });

  it("replaces a negative inventory version with the server-read version", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    const version = (await plane.getHostInventoryDurable("host-1"))?.version;
    const bodies: Array<Record<string, unknown>> = [];
    plane.putHostInventoryDurable = async (_hostId, body) => {
      bodies.push(body as Record<string, unknown>);
      return {
        ok: false as const,
        conflict: true as const,
        error: "host inventory changed since it was read; re-read and retry",
      };
    };

    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/inventory",
        { ...inventory, version: -1 },
        admin,
      ),
    ).toMatchObject({ status: 409 });
    expect(bodies[0]?.version).toBe(version);
  });

  it("returns a conflict instead of deleting an inventory that changed after the capability check", async () => {
    const plane = new ControlPlane();
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    plane.deleteHostInventoryDurable = async () => ({
      ok: false as const,
      conflict: true as const,
      error: "host inventory changed since it was read; re-read and retry",
    });
    expect(
      await invoke(plane, "DELETE", "/api/v1/hosts/host-1/inventory", undefined, admin),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
  });

  it("audits only fields whose exec-config values actually changed", async () => {
    const plane = new ControlPlane();
    const metadata: unknown[] = [];
    const original = plane.appendAuditLog.bind(plane);
    plane.appendAuditLog = async (input) => {
      if (input.action === "host-exec-config:update") metadata.push(input.metadata);
      return original(input);
    };
    expect((await plane.putHostInventoryDurable("host-1", inventory)).ok).toBe(true);
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "source ~/.zshrc", allowedRoots: ["/opt/harness"] },
        admin,
      ),
    ).toMatchObject({ status: 200 });
    expect(metadata.at(-1)).toEqual({ changed: [] });
    expect(
      await invoke(
        plane,
        "PUT",
        "/api/v1/hosts/host-1/exec-config",
        { setupScript: "echo host" },
        admin,
      ),
    ).toMatchObject({ status: 200 });
    expect(metadata.at(-1)).toEqual({ changed: ["setupScript"] });
    expect(
      await invoke(plane, "PUT", "/api/v1/hosts/host-1/exec-config", { allowedRoots: [] }, admin),
    ).toMatchObject({ status: 200 });
    expect(metadata.at(-1)).toEqual({ changed: ["allowedRoots"] });
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

    let stored: Record<string, unknown> = { ...inventory, hostId: "host-1" };
    let putCalls = 0;
    const auditFail = {
      getHostInventoryDurable: async () => stored,
      putHostInventoryDurable: async (_hostId: string, body: Record<string, unknown>) => {
        putCalls += 1;
        stored = { ...body, hostId: "host-1" };
        return { ok: true, config: stored };
      },
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
    expect(putCalls).toBe(0);
    expect(stored.setupScript).toBe("source ~/.zshrc");

    let created: Record<string, unknown> | null = null;
    const createAuditFail = {
      getHostInventoryDurable: async () => created,
      putHostInventoryDurable: async (_hostId: string, body: Record<string, unknown>) => {
        created = { ...body, hostId: "host-new" };
        return { ok: true, config: created };
      },
      appendAuditLog: async () => {
        throw new Error("audit unavailable");
      },
    } as unknown as ControlPlane;
    expect(
      await invoke(
        createAuditFail,
        "PUT",
        "/api/v1/hosts/host-new/exec-config",
        { setupScript: "x" },
        admin,
      ),
    ).toMatchObject({ status: 500 });
    expect(created).toBeNull();

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
    expect(
      await invoke(deniedAudit, "DELETE", "/api/v1/hosts/host-1/inventory", undefined, maintainer),
    ).toMatchObject({ status: 500 });
  });
});
