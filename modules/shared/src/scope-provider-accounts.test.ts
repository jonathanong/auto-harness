import { describe, expect, it } from "vitest";

import { setScopeProviderCommand, setScopeProviderEnabled } from "./scope-provider-accounts.ts";
import { emptyHostInventory, type HostInventory } from "./host-inventory.ts";

function inventoryWithRepo(): HostInventory {
  const inv = emptyHostInventory();
  return {
    ...inv,
    repositories: [
      {
        id: "repo1",
        path: "/repo",
        defaultBranch: "main",
        worktrees: [{ id: "wt1", name: "wt1", path: "/repo/.worktrees/wt1", labels: [] }],
      },
    ],
  };
}

describe("setScopeProviderEnabled", () => {
  it("sets an explicit enabled override at repository scope", () => {
    const inv = inventoryWithRepo();
    const next = setScopeProviderEnabled(inv, { repositoryId: "repo1" }, "acct1", false);
    expect(next.repositories[0]?.providerAccountOverrides).toEqual({ acct1: { enabled: false } });
    // Original untouched.
    expect(inv.repositories[0]?.providerAccountOverrides).toBeUndefined();
  });

  it("sets an explicit enabled override at worktree scope, leaving the repo scope untouched", () => {
    const inv = inventoryWithRepo();
    const next = setScopeProviderEnabled(
      inv,
      { repositoryId: "repo1", worktreeId: "wt1" },
      "acct1",
      true,
    );
    expect(next.repositories[0]?.worktrees[0]?.providerAccountOverrides).toEqual({
      acct1: { enabled: true },
    });
    expect(next.repositories[0]?.providerAccountOverrides).toBeUndefined();
  });

  it("clearing back to undefined removes the override entirely when nothing else is set", () => {
    let inv = setScopeProviderEnabled(
      inventoryWithRepo(),
      { repositoryId: "repo1" },
      "acct1",
      false,
    );
    inv = setScopeProviderEnabled(inv, { repositoryId: "repo1" }, "acct1", undefined);
    expect(inv.repositories[0]?.providerAccountOverrides).toBeUndefined();
  });

  it("clearing enabled preserves a coexisting commandId override at the same scope", () => {
    let inv = setScopeProviderCommand(
      inventoryWithRepo(),
      { repositoryId: "repo1" },
      "acct1",
      "cmd-1",
    );
    inv = setScopeProviderEnabled(inv, { repositoryId: "repo1" }, "acct1", false);
    inv = setScopeProviderEnabled(inv, { repositoryId: "repo1" }, "acct1", undefined);
    expect(inv.repositories[0]?.providerAccountOverrides).toEqual({
      acct1: { commandId: "cmd-1" },
    });
  });

  it("is a no-op for an unknown repository id", () => {
    const inv = inventoryWithRepo();
    const next = setScopeProviderEnabled(inv, { repositoryId: "missing" }, "acct1", false);
    expect(next.repositories).toEqual(inv.repositories);
  });
});

describe("setScopeProviderCommand", () => {
  it("sets a command override at repository scope", () => {
    const next = setScopeProviderCommand(
      inventoryWithRepo(),
      { repositoryId: "repo1" },
      "acct1",
      "cmd-1",
    );
    expect(next.repositories[0]?.providerAccountOverrides).toEqual({
      acct1: { commandId: "cmd-1" },
    });
  });

  it("sets a command override at worktree scope independent of another account's repo override", () => {
    let inv = setScopeProviderCommand(
      inventoryWithRepo(),
      { repositoryId: "repo1" },
      "acct2",
      "cmd-2",
    );
    inv = setScopeProviderCommand(
      inv,
      { repositoryId: "repo1", worktreeId: "wt1" },
      "acct1",
      "cmd-1",
    );
    expect(inv.repositories[0]?.providerAccountOverrides).toEqual({
      acct2: { commandId: "cmd-2" },
    });
    expect(inv.repositories[0]?.worktrees[0]?.providerAccountOverrides).toEqual({
      acct1: { commandId: "cmd-1" },
    });
  });

  it("clearing back to undefined removes the override entirely when nothing else is set", () => {
    let inv = setScopeProviderCommand(
      inventoryWithRepo(),
      { repositoryId: "repo1" },
      "acct1",
      "cmd-1",
    );
    inv = setScopeProviderCommand(inv, { repositoryId: "repo1" }, "acct1", undefined);
    expect(inv.repositories[0]?.providerAccountOverrides).toBeUndefined();
  });

  it("is a no-op for an unknown worktree id", () => {
    const inv = inventoryWithRepo();
    const next = setScopeProviderCommand(
      inv,
      { repositoryId: "repo1", worktreeId: "missing" },
      "acct1",
      "cmd-1",
    );
    expect(next.repositories[0]?.worktrees).toEqual(inv.repositories[0]?.worktrees);
  });
});
