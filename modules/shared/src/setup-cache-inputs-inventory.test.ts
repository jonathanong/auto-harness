import { describe, expect, it } from "vitest";

import {
  applyHostExecConfig,
  inventoryHasExecConfig,
  listExecConfigEdits,
  parseHostExecConfig,
  preserveHostExecConfig,
} from "./host-exec-config.ts";
import {
  addHostWorktree,
  emptyHostInventory,
  upsertHostRepository,
  updateHostWorktree,
} from "./host-inventory.ts";
import { parseHostInventory } from "./host-inventory-parse.ts";

describe("setupCacheInputs exec-config", () => {
  it("parses, applies, and preserves declared extra paths", () => {
    expect(
      parseHostExecConfig({
        setupCacheInputs: ["host.lock"],
        repositories: [
          {
            id: "repo-1",
            setupCacheInputs: ["pnpm-lock.yaml"],
            worktrees: [{ id: "wt-1", setupCacheInputs: ["Cargo.lock"] }],
          },
        ],
      }),
    ).toEqual({
      setupCacheInputs: ["host.lock"],
      repositories: [
        {
          id: "repo-1",
          setupCacheInputs: ["pnpm-lock.yaml"],
          worktrees: [{ id: "wt-1", setupCacheInputs: ["Cargo.lock"] }],
        },
      ],
    });

    const existing = {
      ...emptyHostInventory(),
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt", labels: [] }],
        },
      ],
    };
    const applied = applyHostExecConfig(existing, {
      setupCacheInputs: ["host.lock"],
      repositories: [
        {
          id: "repo-1",
          setupCacheInputs: ["pnpm-lock.yaml"],
          worktrees: [{ id: "wt-1", setupCacheInputs: [] }],
        },
      ],
    });
    expect(applied.setupCacheInputs).toEqual(["host.lock"]);
    expect(applied.repositories[0]?.setupCacheInputs).toEqual(["pnpm-lock.yaml"]);
    expect(applied.repositories[0]?.worktrees[0]).not.toHaveProperty("setupCacheInputs");

    const omitted = preserveHostExecConfig(
      {
        repositories: [
          {
            id: "repo-1",
            path: "/repo",
            defaultBranch: "main",
            worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt", labels: [] }],
          },
        ],
        providerAccounts: [],
      },
      applied,
    );
    expect(omitted.setupCacheInputs).toEqual(["host.lock"]);
    expect(omitted.repositories[0]?.setupCacheInputs).toEqual(["pnpm-lock.yaml"]);
    expect(listExecConfigEdits(existing, applied)).toEqual([
      "setupCacheInputs",
      "repositories.repo-1.setupCacheInputs",
    ]);
    const withWorktree = applyHostExecConfig(applied, {
      repositories: [
        { id: "repo-1", worktrees: [{ id: "wt-1", setupCacheInputs: ["Cargo.lock"] }] },
      ],
    });
    expect(listExecConfigEdits(applied, withWorktree)).toEqual([
      "repositories.repo-1.worktrees.wt-1.setupCacheInputs",
    ]);
    expect(
      preserveHostExecConfig(
        {
          repositories: [
            {
              id: "repo-1",
              path: "/repo",
              defaultBranch: "main",
              worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt", labels: [] }],
            },
          ],
          providerAccounts: [],
        },
        withWorktree,
      ).repositories[0]?.worktrees[0]?.setupCacheInputs,
    ).toEqual(["Cargo.lock"]);
    expect(
      inventoryHasExecConfig({
        repositories: [
          {
            id: "repo-1",
            path: "/repo",
            defaultBranch: "main",
            worktrees: [
              {
                id: "wt",
                name: "wt",
                path: "/wt",
                labels: [],
                setupCacheInputs: ["Cargo.lock"],
              },
            ],
          },
        ],
        providerAccounts: [],
      }),
    ).toBe(true);
  });

  it("rejects absolute extra paths on inventory and exec-config writes", () => {
    expect(
      parseHostInventory({
        setupCacheInputs: ["host.lock"],
        repositories: [
          {
            id: "repo",
            path: "/repo",
            setupCacheInputs: ["pnpm-lock.yaml"],
            worktrees: [
              {
                id: "wt",
                name: "wt",
                path: "/wt",
                labels: [],
                setupCacheInputs: ["Cargo.lock"],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      setupCacheInputs: ["host.lock"],
      repositories: [
        {
          setupCacheInputs: ["pnpm-lock.yaml"],
          worktrees: [{ setupCacheInputs: ["Cargo.lock"] }],
        },
      ],
    });
    expect(() =>
      parseHostInventory({
        repositories: [],
        setupCacheInputs: ["../package.json"],
      }),
    ).toThrow("relative");
  });
});

describe("setupCacheInputs inventory helpers", () => {
  it("upserts and updates declared extra paths without wiping siblings", () => {
    let inv = upsertHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
      setupCacheInputs: ["pnpm-lock.yaml"],
    });
    inv = addHostWorktree(inv, "demo", {
      id: "wt",
      name: "wt",
      path: "/repo/wt",
      labels: [],
      setupCacheInputs: ["Cargo.lock"],
    });
    inv = upsertHostRepository(inv, { id: "demo", path: "/repo2", defaultBranch: "main" });
    expect(inv.repositories[0]?.setupCacheInputs).toEqual(["pnpm-lock.yaml"]);
    inv = updateHostWorktree(inv, "demo", {
      id: "wt",
      name: "wt",
      path: "/repo/wt2",
      labels: ["x"],
    });
    expect(inv.repositories[0]?.worktrees[0]?.setupCacheInputs).toEqual(["Cargo.lock"]);
    inv = updateHostWorktree(inv, "demo", {
      id: "wt",
      name: "wt",
      path: "/repo/wt2",
      labels: ["x"],
      setupCacheInputs: [],
    });
    expect(inv.repositories[0]?.worktrees[0]).not.toHaveProperty("setupCacheInputs");
  });
});
