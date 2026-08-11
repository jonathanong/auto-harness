// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { HostProviderAccountsSection } from "./host-provider-accounts-section.tsx";

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
const baseInventory = { repositories: [], providerAccounts: [], commandProfiles: {} };

describe("HostProviderAccountsSection", () => {
  it("shows the empty state and an accessible attach selection", () => {
    const view = mountForm(
      <HostProviderAccountsSection
        hostId="host"
        inventory={baseInventory}
        accountsById={{ a: account }}
        providersById={{ p: provider }}
        commandsById={{ c: command }}
      />,
    );
    expect(field(view.container, "host-provider-accounts-section").textContent).toContain(
      "No provider accounts attached yet.",
    );
    const select = field<HTMLSelectElement>(view.container, "attach-provider-account-select");
    expect(select.value).toBe("a");
    expect(select.labels?.[0]?.textContent).toBe("provider account");
    view.unmount();
  });

  it("renders catalog, fallback, and unavailable account rows", () => {
    const accountsById = {
      a: account,
      b: { ...account, id: "b", providerId: "missing-provider", label: "other" },
      z: { ...account, id: "z", label: "Zulu" },
      y: { ...account, id: "y", providerId: "missing-provider", label: "Alpha" },
    };
    const view = mountForm(
      <HostProviderAccountsSection
        hostId="host"
        inventory={{
          ...baseInventory,
          providerAccounts: [
            { providerAccountId: "a", commandId: "c" },
            { providerAccountId: "b", commandId: "removed-command" },
            { providerAccountId: "removed-account" },
          ],
        }}
        accountsById={accountsById}
        providersById={{ p: provider }}
        commandsById={{ c: command }}
      />,
    );
    expect(field(view.container, "host-provider-account-row-a").textContent).toContain(
      "Claude — primary",
    );
    expect(field(view.container, "host-provider-account-row-a").textContent).toContain(
      "claude-run",
    );
    expect(field(view.container, "host-provider-account-row-b").textContent).toContain(
      "missing-provider — other",
    );
    expect(field(view.container, "host-provider-account-row-b").textContent).toContain(
      "removed-command",
    );
    expect(
      field(view.container, "host-provider-account-row-removed-account").textContent,
    ).toContain("— (no default command)");
    const select = field<HTMLSelectElement>(view.container, "attach-provider-account-select");
    expect([...select.options].map((option) => option.text)).toEqual([
      "Claude — Zulu",
      "missing-provider — Alpha",
    ]);
    view.unmount();
  });
});
