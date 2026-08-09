import { describe, expect, it } from "vitest";

import { resolveProviderAccountsForScope } from "./provider-cascade-scope.ts";
import type { ProviderCatalog } from "./provider-cascade.ts";
import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import type { Provider, ProviderAccount } from "./providers.ts";

function worktree(overrides?: HostWorktree["providerAccountOverrides"]): HostWorktree {
  return {
    id: "wt1",
    name: "wt1",
    path: "/repo/.worktrees/wt1",
    labels: [],
    ...(overrides !== undefined ? { providerAccountOverrides: overrides } : {}),
  };
}

function repository(overrides?: HostRepository["providerAccountOverrides"]): HostRepository {
  return {
    id: "repo1",
    path: "/repo",
    defaultBranch: "main",
    worktrees: [],
    ...(overrides !== undefined ? { providerAccountOverrides: overrides } : {}),
  };
}

function inventory(providerAccounts: HostInventory["providerAccounts"] = []): HostInventory {
  return { repositories: [], providerAccounts, commandProfiles: {} };
}

const provider: Provider = {
  id: "prov1",
  name: "claude",
  defaultCommandId: "cmd-default",
  createdAt: "t",
  updatedAt: "t",
};
const account: ProviderAccount = {
  id: "acct1",
  providerId: "prov1",
  label: "x@y.com",
  createdAt: "t",
  updatedAt: "t",
};
const catalog: ProviderCatalog = {
  providers: { prov1: provider },
  providerAccounts: { acct1: account },
};

describe("resolveProviderAccountsForScope", () => {
  it("returns an empty list when no accounts are host-attached", () => {
    expect(resolveProviderAccountsForScope(undefined, undefined, inventory(), catalog)).toEqual([]);
    expect(resolveProviderAccountsForScope(undefined, undefined, undefined, catalog)).toEqual([]);
  });

  it("reports no provider default when the attached account is absent from the catalog", () => {
    const result = resolveProviderAccountsForScope(
      undefined,
      undefined,
      inventory([{ providerAccountId: "missing" }]),
      catalog,
    );
    expect(result[0]).toMatchObject({ commandId: undefined, commandSource: "none" });
  });

  it("defaults to enabled/host-sourced with the provider default command, no overrides", () => {
    const result = resolveProviderAccountsForScope(
      undefined,
      undefined,
      inventory([{ providerAccountId: "acct1" }]),
      catalog,
    );
    expect(result).toEqual([
      {
        providerAccountId: "acct1",
        enabled: true,
        enabledSource: "host",
        commandId: "cmd-default",
        commandSource: "provider-default",
      },
    ]);
  });

  it("reports the host-level command override and its source", () => {
    const result = resolveProviderAccountsForScope(
      undefined,
      undefined,
      inventory([{ providerAccountId: "acct1", commandId: "cmd-host" }]),
      catalog,
    );
    expect(result[0]).toMatchObject({ commandId: "cmd-host", commandSource: "host" });
  });

  it("repo-scope override wins over host, worktree wins over repo", () => {
    const inv = inventory([{ providerAccountId: "acct1", commandId: "cmd-host" }]);
    const repo = repository({ acct1: { enabled: false, commandId: "cmd-repo" } });
    const wt = worktree({ acct1: { enabled: true, commandId: "cmd-wt" } });

    const repoOnly = resolveProviderAccountsForScope(undefined, repo, inv, catalog);
    expect(repoOnly[0]).toMatchObject({
      enabled: false,
      enabledSource: "repository",
      commandId: "cmd-repo",
      commandSource: "repository",
    });

    const withWorktree = resolveProviderAccountsForScope(wt, repo, inv, catalog);
    expect(withWorktree[0]).toMatchObject({
      enabled: true,
      enabledSource: "worktree",
      commandId: "cmd-wt",
      commandSource: "worktree",
    });
  });

  it("reports commandSource 'none' when nothing resolves (no provider default either)", () => {
    const noDefaultCatalog: ProviderCatalog = {
      providers: { prov1: { ...provider, defaultCommandId: null } },
      providerAccounts: { acct1: account },
    };
    const result = resolveProviderAccountsForScope(
      undefined,
      undefined,
      inventory([{ providerAccountId: "acct1" }]),
      noDefaultCatalog,
    );
    expect(result[0]).toMatchObject({ commandId: undefined, commandSource: "none" });
  });

  it("an empty override object ({}) at repo scope still inherits from host", () => {
    const inv = inventory([{ providerAccountId: "acct1", commandId: "cmd-host" }]);
    const result = resolveProviderAccountsForScope(
      undefined,
      repository({ acct1: {} }),
      inv,
      catalog,
    );
    expect(result[0]).toMatchObject({
      enabled: true,
      enabledSource: "host",
      commandId: "cmd-host",
      commandSource: "host",
    });
  });
});
