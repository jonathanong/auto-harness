import { describe, expect, it } from "vitest";

import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import type { Provider, ProviderAccount } from "./providers.ts";
import {
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
} from "./provider-cascade.ts";

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

describe("resolveProviderAccountEnabled", () => {
  it("disabled when the account is not attached to the host at all", () => {
    expect(resolveProviderAccountEnabled("acct1", undefined, undefined, inventory())).toBe(false);
  });

  it("enabled when attached to the host with no overrides", () => {
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        undefined,
        undefined,
        inventory([{ providerAccountId: "acct1" }]),
      ),
    ).toBe(true);
  });

  it("undefined inventory (no host) resolves to disabled", () => {
    expect(resolveProviderAccountEnabled("acct1", undefined, undefined, undefined)).toBe(false);
  });

  it("repo-scope explicit false disables even though host-attached", () => {
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        undefined,
        repository({ acct1: { enabled: false } }),
        inventory([{ providerAccountId: "acct1" }]),
      ),
    ).toBe(false);
  });

  it("repo-scope explicit true does NOT enable when not host-attached — overrides can only narrow", () => {
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        undefined,
        repository({ acct1: { enabled: true } }),
        inventory(),
      ),
    ).toBe(false);
  });

  it("a stale repo-scope override left over from before detachment stays disabled", () => {
    // Detaching an account doesn't clean up overrides on its repositories/worktrees —
    // an `enabled: true` override set while attached must not resurrect eligibility.
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        worktree({ acct1: { enabled: true } }),
        repository({ acct1: { enabled: true } }),
        inventory([{ providerAccountId: "acct2" }]),
      ),
    ).toBe(false);
  });

  it("worktree scope wins over repo scope when both set", () => {
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        worktree({ acct1: { enabled: true } }),
        repository({ acct1: { enabled: false } }),
        inventory([{ providerAccountId: "acct1" }]),
      ),
    ).toBe(true);
  });

  it("an empty override object ({}) inherits from the next scope down, not from the base attachment", () => {
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        worktree({ acct1: {} }),
        repository({ acct1: { enabled: false } }),
        inventory([{ providerAccountId: "acct1" }]),
      ),
    ).toBe(false);
  });

  it("worktree override for a different account doesn't shadow the target account", () => {
    expect(
      resolveProviderAccountEnabled(
        "acct1",
        worktree({ acct2: { enabled: false } }),
        undefined,
        inventory([{ providerAccountId: "acct1" }]),
      ),
    ).toBe(true);
  });

  it("doesn't crash on a stale real-storage record missing providerAccounts at runtime", () => {
    // The field is typed as required, but a record persisted before it existed can still
    // lack it — this must degrade to disabled, not throw.
    const stale = { repositories: [], commandProfiles: {} } as unknown as HostInventory;
    expect(resolveProviderAccountEnabled("acct1", undefined, undefined, stale)).toBe(false);
  });
});

describe("resolveProviderAccountCommandId", () => {
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
    usageLimitCooldownSeconds: 18_000,
    maxConcurrentSessions: 1,
    usageLimitedUntil: null,
    lastUsageLimitedAt: null,
    lastAssignedAt: null,
    createdAt: "t",
    updatedAt: "t",
  };
  const catalog: ProviderCatalog = {
    providers: { prov1: provider },
    providerAccounts: { acct1: account },
  };

  it("falls back to the provider's default command when nothing overrides it", () => {
    expect(
      resolveProviderAccountCommandId("acct1", undefined, undefined, inventory(), catalog),
    ).toBe("cmd-default");
  });

  it("host-level account commandId wins over the provider default", () => {
    expect(
      resolveProviderAccountCommandId(
        "acct1",
        undefined,
        undefined,
        inventory([{ providerAccountId: "acct1", commandId: "cmd-host" }]),
        catalog,
      ),
    ).toBe("cmd-host");
  });

  it("repo override wins over host-level account commandId", () => {
    expect(
      resolveProviderAccountCommandId(
        "acct1",
        undefined,
        repository({ acct1: { commandId: "cmd-repo" } }),
        inventory([{ providerAccountId: "acct1", commandId: "cmd-host" }]),
        catalog,
      ),
    ).toBe("cmd-repo");
  });

  it("worktree override wins over repo override", () => {
    expect(
      resolveProviderAccountCommandId(
        "acct1",
        worktree({ acct1: { commandId: "cmd-wt" } }),
        repository({ acct1: { commandId: "cmd-repo" } }),
        inventory(),
        catalog,
      ),
    ).toBe("cmd-wt");
  });

  it("returns undefined when the provider has no default and nothing overrides it", () => {
    const noDefaultCatalog: ProviderCatalog = {
      providers: { prov1: { ...provider, defaultCommandId: null } },
      providerAccounts: { acct1: account },
    };
    expect(
      resolveProviderAccountCommandId("acct1", undefined, undefined, inventory(), noDefaultCatalog),
    ).toBeUndefined();
  });

  it("returns undefined when the account isn't in the catalog at all", () => {
    expect(
      resolveProviderAccountCommandId("missing", undefined, undefined, inventory(), {
        providers: {},
        providerAccounts: {},
      }),
    ).toBeUndefined();
  });

  it("falls back to the provider default (not a crash) on a stale record missing providerAccounts", () => {
    const stale = { repositories: [], commandProfiles: {} } as unknown as HostInventory;
    expect(resolveProviderAccountCommandId("acct1", undefined, undefined, stale, catalog)).toBe(
      "cmd-default",
    );
  });
});
