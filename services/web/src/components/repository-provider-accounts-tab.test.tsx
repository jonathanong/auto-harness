// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { RepositoryProviderAccountsTab } from "./repository-provider-accounts-tab.tsx";

const provider = {
  id: "p",
  name: "Claude",
  defaultCommandId: "c",
  createdAt: "now",
  updatedAt: "now",
};
const account = {
  id: "a",
  providerId: "p",
  label: "primary",
  usageLimitCooldownSeconds: 18_000,
  maxConcurrentSessions: 1,
  usageLimitedUntil: null,
  lastUsageLimitedAt: null,
  lastAssignedAt: null,
  createdAt: "now",
  updatedAt: "now",
};
const command = {
  id: "c",
  name: "claude-run",
  argv: ["claude"],
  appendPrompt: true,
  providerId: "p",
  createdAt: "now",
  updatedAt: "now",
};
const inventory = {
  repositories: [
    {
      id: "repo",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [],
      providerAccountOverrides: { a: { enabled: false, commandId: "c" } },
    },
  ],
  providerAccounts: [{ providerAccountId: "a" }],
  commandProfiles: {},
};

describe("RepositoryProviderAccountsTab", () => {
  it("explains when the repository is not attached", () => {
    const view = mountForm(
      <RepositoryProviderAccountsTab
        repositoryId="repo"
        attachedHosts={[]}
        hostInventories={[]}
        catalog={{ providers: {}, providerAccounts: {} }}
        providerAccountsById={{}}
        providersById={{}}
        commandsById={{}}
      />,
    );
    expect(view.container.textContent).toContain("Not attached to any host yet");
    view.unmount();
  });

  it("renders each host, including an unavailable inventory", () => {
    const view = mountForm(
      <RepositoryProviderAccountsTab
        repositoryId="repo"
        attachedHosts={[{ hostId: "host/one" }, { hostId: "host/two" }]}
        hostInventories={[inventory, null]}
        catalog={{ providers: { p: provider }, providerAccounts: { a: account } }}
        providerAccountsById={{ a: account }}
        providersById={{ p: provider }}
        commandsById={{ c: command }}
      />,
    );
    expect(
      field<HTMLAnchorElement>(
        view.container,
        "repository-provider-accounts-host-host/one",
      ).getAttribute("href"),
    ).toBe("/hosts/host%2Fone");
    expect(field(view.container, "repository-provider-accounts-host-host/two").textContent).toBe(
      "host/two",
    );
    expect(field(view.container, "provider-scope-row-a").textContent).toContain("Claude — primary");
    expect(field(view.container, "provider-scope-table-empty").textContent).toContain(
      "No provider accounts",
    );
    view.unmount();
  });
});
