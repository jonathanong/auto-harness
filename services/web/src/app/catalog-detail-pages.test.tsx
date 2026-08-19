import React from "react";
import { describe, expect, it } from "vitest";

import CommandDetailPage from "./commands/[commandId]/page.tsx";
import ProviderDetailPage from "./providers/[providerId]/page.tsx";
import { jsonResponse, renderPage, stubApi } from "./route-test-helpers.tsx";

const noSearch = Promise.resolve({});

describe("control catalog detail routes", () => {
  it("renders a command owner and standalone command details", async () => {
    stubApi({
      "/api/v1/commands/cmd-1": {
        id: "cmd-1",
        name: "run",
        argv: ["tool", "--prompt"],
        providerId: "p-1",
        appendPrompt: true,
      },
      "/api/v1/providers": { items: [{ id: "p-1", name: "Claude", defaultCommandId: "cmd-1" }] },
    });
    let html = await renderPage(
      CommandDetailPage({ params: Promise.resolve({ commandId: "cmd-1" }) }),
    );
    expect(html).toContain('data-pw="page-command-detail"');
    expect(html).toContain("Claude");
    expect(html).toContain("tool --prompt");
    expect(html).toContain("Append prompt");

    stubApi({
      "/api/v1/commands/standalone": {
        id: "standalone",
        name: "echo",
        argv: ["echo"],
        providerId: null,
        appendPrompt: false,
      },
      "/api/v1/providers": jsonResponse({}, 503),
    });
    html = await renderPage(
      CommandDetailPage({ params: Promise.resolve({ commandId: "standalone" }) }),
    );
    expect(html).toContain("— (standalone)");
    expect(html).toContain('data-pw="page-command-detail"');

    stubApi({
      "/api/v1/commands/no-providers": {
        id: "no-providers",
        name: "noop",
        argv: [],
        providerId: null,
        appendPrompt: false,
      },
      "/api/v1/providers": {},
    });
    html = await renderPage(
      CommandDetailPage({ params: Promise.resolve({ commandId: "no-providers" }) }),
    );
    expect(html).toContain("noop");
  });

  it("renders the command not-found route", async () => {
    stubApi({ "/api/v1/commands/missing": jsonResponse({}, 404) });
    const html = await renderPage(
      CommandDetailPage({ params: Promise.resolve({ commandId: "missing" }) }),
    );
    expect(html).toContain('data-pw="page-command-detail-not-found"');
    expect(html).toContain("No command");
  });

  it("renders provider accounts, commands, settings, and missing provider", async () => {
    stubApi({
      "/api/v1/providers/p-1": { id: "p-1", name: "Claude", defaultCommandId: "cmd-1" },
      "/api/v1/provider-accounts": { items: [{ id: "a-1", providerId: "p-1", label: "work" }] },
      "/api/v1/commands": {
        items: [
          { id: "cmd-1", name: "run", argv: ["tool"], providerId: "p-1", appendPrompt: true },
          { id: "cmd-2", name: "other", argv: ["other"], providerId: "p-1", appendPrompt: false },
        ],
      },
      "/api/v1/host-inventories": {
        items: [
          { hostId: "host-1", providerAccounts: [{ providerAccountId: "a-1" }] },
          { hostId: "host-2" },
        ],
      },
    });
    for (const tab of [undefined, "commands", "settings", "unknown"]) {
      const html = await renderPage(
        ProviderDetailPage({
          params: Promise.resolve({ providerId: "p-1" }),
          searchParams: Promise.resolve(tab ? { tab } : {}),
        }),
      );
      expect(html).toContain('data-pw="page-provider-detail"');
      expect(html).toContain("Claude");
      if (!tab) {
        expect(html).not.toContain('data-pw="provider-account-unattached-warning"');
      }
    }
    stubApi({ "/api/v1/providers/missing": jsonResponse({}, 404) });
    const missing = await renderPage(
      ProviderDetailPage({
        params: Promise.resolve({ providerId: "missing" }),
        searchParams: noSearch,
      }),
    );
    expect(missing).toContain('data-pw="page-provider-detail-not-found"');
  });

  it("warns when a provider account is attached to no host", async () => {
    stubApi({
      "/api/v1/providers/p-1": { id: "p-1", name: "Claude", defaultCommandId: null },
      "/api/v1/provider-accounts": { items: [{ id: "a-1", providerId: "p-1", label: "work" }] },
      "/api/v1/commands": { items: [] },
      "/api/v1/host-inventories": { items: [{ hostId: "host-1", providerAccounts: [] }] },
    });
    const html = await renderPage(
      ProviderDetailPage({
        params: Promise.resolve({ providerId: "p-1" }),
        searchParams: noSearch,
      }),
    );
    expect(html).toContain('data-pw="provider-account-unattached-warning"');
    expect(html).toContain("work is not attached to any host");
  });

  it("keeps provider detail tabs empty when supporting APIs fail", async () => {
    stubApi({
      "/api/v1/providers/p-2": { id: "p-2", name: "Empty", defaultCommandId: null },
      "/api/v1/provider-accounts": jsonResponse({}, 503),
      "/api/v1/commands": jsonResponse({}, 503),
      "/api/v1/host-inventories": jsonResponse({}, 503),
    });
    const html = await renderPage(
      ProviderDetailPage({
        params: Promise.resolve({ providerId: "p-2" }),
        searchParams: noSearch,
      }),
    );
    expect(html).toContain("No accounts of this provider yet.");
    const commands = await renderPage(
      ProviderDetailPage({
        params: Promise.resolve({ providerId: "p-2" }),
        searchParams: Promise.resolve({ tab: "commands" }),
      }),
    );
    expect(commands).toContain("No commands owned by this provider yet.");

    stubApi({
      "/api/v1/providers/p-3": { id: "p-3", name: "Missing arrays", defaultCommandId: null },
      "/api/v1/provider-accounts": {},
      "/api/v1/commands": {},
      "/api/v1/host-inventories": {},
    });
    const missingArrays = await renderPage(
      ProviderDetailPage({
        params: Promise.resolve({ providerId: "p-3" }),
        searchParams: Promise.resolve({ tab: "commands" }),
      }),
    );
    expect(missingArrays).toContain("No commands owned by this provider yet.");
  });
});
