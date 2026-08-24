// @vitest-environment happy-dom

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Command, HostInventory, Provider, ProviderAccount } from "@auto-harness/shared";
import { HostShell } from "./host-shell.tsx";
import { ProviderAccountsReadonly } from "./provider-accounts-readonly.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mountedRoots = new Set<() => void>();

const router = {
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
} satisfies AppRouterInstance;

function withNavigation(node: React.ReactNode, pathname: string | null) {
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          {node}
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const unmount = () => {
    if (!mountedRoots.delete(unmount)) return;
    act(() => root.unmount());
  };
  mountedRoots.add(unmount);
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount,
  };
}

afterEach(() => {
  for (const unmount of mountedRoots) unmount();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("host-pane shell", () => {
  it("marks the nested route active and renders online status", () => {
    const view = mount(
      withNavigation(
        <HostShell hostId="host-1" online>
          <p>Current page</p>
        </HostShell>,
        "/repositories/repo-1",
      ),
    );
    const text = view.container.querySelector('[data-pw="host-shell"]')?.textContent ?? "";
    expect(text).toContain("Host UI for host-1");
    expect(text).toContain("Debug-only");
    expect(text).toContain("operators should use the control plane");
    expect(view.container.querySelector('[data-pw="host-shell-debug-only"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="host-shell-online"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="nav-repositories"]')?.className).toContain(
      "bg-muted",
    );
    expect(view.container.querySelector('[data-pw="nav-sessions"]')?.className).not.toMatch(
      /(?:^|\\s)bg-muted(?:\\s|$)/,
    );

    view.rerender(
      withNavigation(
        <HostShell hostId="host-1">
          <p>Settings</p>
        </HostShell>,
        "/settings",
      ),
    );
    expect(view.container.querySelector('[data-pw="host-shell-online"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="nav-settings"]')?.className).toContain(
      "bg-muted",
    );
    view.rerender(
      withNavigation(
        <HostShell hostId="host-1" online={false}>
          <p>Fallback route</p>
        </HostShell>,
        null,
      ),
    );
    view.unmount();
  });
});

const provider: Provider = {
  id: "provider-1",
  name: "Claude",
  defaultCommandId: "command-1",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const command: Command = {
  id: "command-1",
  name: "claude-print",
  argv: ["claude"],
  appendPrompt: true,
  providerId: provider.id,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const account: ProviderAccount = {
  id: "account-1",
  providerId: provider.id,
  label: "operator@example.test",
  usageLimitCooldownSeconds: 300,
  maxConcurrentSessions: 1,
  usageLimitedUntil: "2020-01-01T00:00:00.000Z",
  lastUsageLimitedAt: "2019-12-31T00:00:00.000Z",
  lastAssignedAt: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

function inventory(providerAccounts: HostInventory["providerAccounts"]): HostInventory {
  return { repositories: [], providerAccounts };
}

describe("read-only provider accounts", () => {
  it("renders the empty state and a populated health/command table", () => {
    const empty = renderToStaticMarkup(
      <ProviderAccountsReadonly
        inventory={inventory([])}
        accountsById={{}}
        providersById={{}}
        commandsById={{}}
      />,
    );
    expect(empty).toContain("No provider accounts attached to this host.");

    const markup = renderToStaticMarkup(
      <ProviderAccountsReadonly
        inventory={inventory([
          { providerAccountId: account.id },
          { providerAccountId: "account-paused" },
          { providerAccountId: "account-command", commandId: "missing-command" },
          { providerAccountId: "stale-account" },
        ])}
        accountsById={{
          [account.id]: account,
          "account-paused": {
            ...account,
            id: "account-paused",
            providerId: "unknown-provider",
            usageLimitedUntil: "2099-01-01T00:00:00.000Z",
          },
          "account-command": { ...account, id: "account-command" },
        }}
        providersById={{ [provider.id]: provider }}
        commandsById={{ [command.id]: command }}
      />,
    );
    expect(markup).toContain("Claude — operator@example.test");
    expect(markup).toContain("claude-print");
    expect(markup).toContain("unknown-provider — operator@example.test");
    expect(markup).toContain("Paused until 2099-01-01T00:00:00.000Z");
    expect(markup).toContain("missing-command");
    expect(markup).toContain("stale-account");
    expect(markup).toContain("— (no default command)");
  });
});
