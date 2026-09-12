/* eslint-disable max-lines -- workspace lifecycle and path fences share one fixture. */
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { WorkspaceManager } from "./workspace-manager.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ah-workspace-"));
  roots.push(root);
  const slot = join(root, "pool", "slot");
  await mkdir(slot, { recursive: true });
  return {
    root,
    slot,
    config: parseDaemonConfig({
      hostId: "workspace-host",
      allowedRoots: [root],
      repositories: [],
      workspacePools: [
        { workspacePoolId: "pool", slots: [{ id: "slot", name: "isolated", path: slot }] },
      ],
    }),
  };
}

describe("WorkspaceManager", () => {
  it("serializes a slot and recreates exactly that slot after cleanup", async () => {
    const { slot, config } = await fixture();
    await writeFile(join(slot, "leftover.txt"), "old state");
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");

    await expect(manager.claim("pool", "slot")).rejects.toThrow("already busy");
    await manager.destroyWorkspaceAfter(claimed);

    expect(await readdir(slot)).toEqual([]);
    await expect(manager.claim("pool", "slot")).resolves.toMatchObject({
      cwd: expect.stringMatching(/\/pool\/slot$/),
    });
  });

  it("refuses unrestricted and root-equal destructive workspace paths", async () => {
    const { root, config } = await fixture();
    config.allowedRoots = [];
    await expect(new WorkspaceManager(config).claim("pool", "slot")).rejects.toThrow(
      "require non-empty allowedRoots",
    );

    config.allowedRoots = [root];
    config.workspacePools![0]!.slots[0]!.path = root;
    await expect(new WorkspaceManager(config).claim("pool", "slot")).rejects.toThrow(
      "strict descendant",
    );
  });

  it("validates a candidate's cleared roots and requires an existing slot directory", async () => {
    const { root, slot, config } = await fixture();
    const manager = new WorkspaceManager(config);
    await expect(manager.ensureAll({ ...config, allowedRoots: [] })).rejects.toThrow(
      "non-empty allowedRoots",
    );

    config.workspacePools![0]!.slots[0]!.path = join(root, "missing");
    await expect(manager.ensureAll()).rejects.toThrow("workspace slot path must exist");
    await rm(slot, { recursive: true, force: true });
    await writeFile(slot, "not a directory");
    config.workspacePools![0]!.slots[0]!.path = slot;
    await expect(manager.ensureAll()).rejects.toThrow("workspace slot path must be a directory");
  });

  it("rejects unknown and aborted claims without leaving the slot busy", async () => {
    const { config } = await fixture();
    const manager = new WorkspaceManager(config);
    await expect(manager.claim("missing", "slot")).rejects.toThrow("Unknown workspace pool");
    await expect(manager.claim("pool", "missing")).rejects.toThrow("Unknown workspace slot");
    const controller = new AbortController();
    controller.abort();
    await expect(manager.claim("pool", "slot", controller.signal)).rejects.toThrow();
    const claimed = await manager.claim("pool", "slot");
    manager.release(claimed);
    await expect(manager.claim("pool", "slot")).resolves.toMatchObject({ slot: { id: "slot" } });
  });

  it("revalidates policy and inventory changes before execution", async () => {
    const { root, slot, config } = await fixture();
    config.setupScript = "echo host setup";
    const manager = new WorkspaceManager(config);
    await expect(manager.ensureAll()).resolves.toBeUndefined();
    await expect(manager.ensureAll(config)).resolves.toBeUndefined();
    const claimed = await manager.claim("pool", "slot");
    expect(claimed).toMatchObject({
      cwd: expect.stringMatching(/\/pool\/slot$/),
      hostSetupScript: "echo host setup",
      allowedRoots: [root],
    });
    manager.noteInventoryChange();
    await expect(claimed.currentExecutionTarget()).resolves.toBeUndefined();
    config.workspacePools![0]!.slots[0]!.path = join(root, "moved");
    manager.noteInventoryChange();
    await expect(claimed.currentExecutionTarget()).rejects.toThrow("inventory changed");
    manager.release(claimed);

    manager.setAllowedRootsPolicy([]);
    await expect(manager.claim("pool", "slot")).rejects.toThrow("non-empty allowedRoots");
    manager.clearAllowedRootsPolicy();
    config.workspacePools![0]!.slots[0]!.path = slot;
    await expect(manager.claim("pool", "slot")).resolves.toMatchObject({
      cwd: expect.stringMatching(/\/pool\/slot$/),
    });
  });

  it("retains usable roots when an extra configured root cannot be resolved", async () => {
    const { root, config } = await fixture();
    config.allowedRoots = [root, "/definitely-not-an-auto-harness-root"];
    const manager = new WorkspaceManager(config);

    const claimed = await manager.claim("pool", "slot");

    manager.release(claimed);
  });

  it("accepts a slot under a later allowed root when an earlier root is unrelated", async () => {
    const { root, config } = await fixture();
    const { root: unrelated } = await fixture();
    config.allowedRoots = [unrelated, root];
    const manager = new WorkspaceManager(config);

    const claimed = await manager.claim("pool", "slot");

    expect(claimed.cwd).toMatch(/\/pool\/slot$/);
    manager.release(claimed);
  });

  it("rejects a claimed slot whose inventory entry is replaced", async () => {
    const { root, config } = await fixture();
    const moved = join(root, "pool", "moved");
    await mkdir(moved, { recursive: true });
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");

    config.workspacePools![0]!.slots[0] = {
      ...config.workspacePools![0]!.slots[0]!,
      path: moved,
    };
    manager.noteInventoryChange();

    await expect(claimed.currentExecutionTarget()).rejects.toThrow("inventory changed");
    manager.release(claimed);
  });

  it("rejects a removed slot path without disguising an unchanged inventory", async () => {
    const { slot, config } = await fixture();
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");
    await rm(slot, { recursive: true, force: true });

    await expect(claimed.currentExecutionTarget()).rejects.toThrow(
      "workspace slot path must exist",
    );
    manager.release(claimed);
  });

  it("rejects an in-place move to a different canonical workspace path", async () => {
    const { root, config } = await fixture();
    const moved = join(root, "pool", "moved");
    await mkdir(moved, { recursive: true });
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");
    config.workspacePools![0]!.slots[0]!.path = moved;
    manager.noteInventoryChange();

    await expect(claimed.currentExecutionTarget()).rejects.toThrow("inventory changed");
    manager.release(claimed);
  });

  it("rejects a candidate that aliases a path held by a leased slot", async () => {
    const { root, config } = await fixture();
    const slot = config.workspacePools![0]!.slots[0]!;
    const alias = join(root, "pool", "alias");
    await symlink(slot.path, alias);
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");
    const candidate = {
      ...config,
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "replacement", name: "replacement", path: alias }],
        },
      ],
    };

    await expect(manager.ensureAll(candidate)).rejects.toThrow("aliases leased slot");
    await expect(
      manager.ensureAll({
        ...config,
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "slot", name: "slot", path: alias }],
          },
        ],
      }),
    ).rejects.toThrow("cannot change the path of busy workspace slot");
    manager.release(claimed);
  });

  it("permits an unchanged busy slot and a candidate that removes it", async () => {
    const { config } = await fixture();
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");

    await expect(manager.ensureAll(config)).resolves.toBeUndefined();
    await expect(manager.ensureAll({ ...config, workspacePools: [] })).resolves.toBeUndefined();
    manager.release(claimed);
  });

  it("keeps case-distinct POSIX workspace paths distinct", async () => {
    if (process.platform !== "linux") return;
    const { root, config } = await fixture();
    const upper = join(root, "pool", "Slot");
    await mkdir(upper);
    const manager = new WorkspaceManager(config);
    const claimed = await manager.claim("pool", "slot");

    await expect(
      manager.ensureAll({
        ...config,
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "replacement", name: "replacement", path: upper }],
          },
        ],
      }),
    ).resolves.toBeUndefined();
    manager.release(claimed);
  });

  it("reopens claims after an inventory update fence is rolled back", async () => {
    const { config } = await fixture();
    const manager = new WorkspaceManager(config);
    manager.beginInventoryUpdate();
    await expect(manager.claim("pool", "slot")).rejects.toThrow(
      "host inventory update in progress",
    );
    manager.endInventoryUpdate();
    const claimed = await manager.claim("pool", "slot");
    expect(claimed.slot.id).toBe("slot");
    manager.release(claimed);
  });

  it("always releases a claim when destructive cleanup fails", async () => {
    const { config } = await fixture();
    const remove = vi.fn(async () => {
      throw new Error("cleanup unavailable");
    });
    const manager = new WorkspaceManager(config, {
      rm: remove,
      mkdir: vi.fn(async () => undefined),
    });
    const claimed = await manager.claim("pool", "slot");
    await expect(manager.destroyWorkspaceAfter(claimed)).rejects.toThrow("cleanup unavailable");
    await expect(manager.claim("pool", "slot")).resolves.toMatchObject({ slot: { id: "slot" } });
  });
});
