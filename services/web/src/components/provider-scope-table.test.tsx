// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { ProviderScopeTable } from "./provider-scope-table.tsx";

const account = {
  id: "account/one",
  providerId: "provider/one",
  label: "primary@example.com",
  usageLimitCooldownSeconds: 18_000,
  usageLimitedUntil: null,
  lastUsageLimitedAt: null,
  lastAssignedAt: null,
  createdAt: "now",
  updatedAt: "now",
};
const provider = {
  id: "provider/one",
  name: "Claude",
  defaultCommandId: "command/one",
  createdAt: "now",
  updatedAt: "now",
};
const command = {
  id: "command/one",
  name: "claude-run",
  argv: ["claude"],
  appendPrompt: true,
  providerId: "provider/one",
  createdAt: "now",
  updatedAt: "now",
};

describe("ProviderScopeTable", () => {
  it("renders an empty host attachment state", () => {
    const view = mountForm(
      <ProviderScopeTable
        hostId="host"
        scope={{ repositoryId: "repo" }}
        inheritedEnabledLabel="host"
        resolutions={[]}
        overridesAtScope={{}}
        accountsById={{}}
        providersById={{}}
        commandsById={{}}
      />,
    );
    expect(field(view.container, "provider-scope-table-empty").textContent).toContain(
      "No provider accounts",
    );
    view.unmount();
  });

  it("renders resolved, missing, and removed catalog account states", () => {
    const view = mountForm(
      <ProviderScopeTable
        hostId="host"
        scope={{ repositoryId: "repo" }}
        inheritedEnabledLabel="host"
        resolutions={[
          {
            providerAccountId: "account/one",
            enabled: false,
            enabledSource: "worktree",
            commandId: "command/one",
            commandSource: "worktree",
          },
          {
            providerAccountId: "account/two",
            enabled: true,
            enabledSource: "host",
            commandId: "removed-command",
            commandSource: "host",
          },
          {
            providerAccountId: "removed-account",
            enabled: true,
            enabledSource: "legacy" as never,
            commandId: undefined,
            commandSource: "none",
          },
        ]}
        overridesAtScope={{ "account/one": { enabled: false, commandId: "command/one" } }}
        accountsById={{
          "account/one": account,
          "account/two": {
            ...account,
            id: "account/two",
            providerId: "removed-provider",
            label: "other",
          },
        }}
        providersById={{ "provider/one": provider }}
        commandsById={{ "command/one": command }}
      />,
    );
    expect(field(view.container, "provider-scope-row-account/one").textContent).toContain(
      "Claude — primary@example.com",
    );
    expect(field(view.container, "provider-scope-inherited-account/one").textContent).toBe(
      "this worktree",
    );
    expect(field(view.container, "provider-scope-effective-command-account/one").textContent).toBe(
      "claude-run",
    );
    expect(field(view.container, "provider-scope-row-account/two").textContent).toContain(
      "removed-provider — other",
    );
    expect(field(view.container, "provider-scope-effective-command-account/two").textContent).toBe(
      "removed-command",
    );
    expect(field(view.container, "provider-scope-inherited-removed-account").textContent).toBe(
      "legacy",
    );
    expect(
      field(view.container, "provider-scope-effective-command-removed-account").textContent,
    ).toBe("— (none)");
    expect(
      field<HTMLSelectElement>(view.container, "scope-provider-enabled-select-account/one").value,
    ).toBe("false");
    expect(
      field<HTMLSelectElement>(view.container, "scope-provider-command-select-account/one").value,
    ).toBe("command/one");
    view.unmount();
  });
});
