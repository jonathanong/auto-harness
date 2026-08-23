import React from "react";
import { describe, expect, it } from "vitest";

import CommandsPage from "./commands/page.tsx";
import ProvidersPage from "./providers/page.tsx";
import RepositoriesPage from "./repositories/page.tsx";
import { jsonResponse, renderPage, stubApi } from "./route-test-helpers.tsx";

describe("control catalog list routes", () => {
  it("renders commands with provider names and links", async () => {
    stubApi({
      "/api/v1/commands": {
        items: [
          {
            id: "cmd-1",
            name: "run",
            argv: ["tool", "--prompt"],
            providerId: "p-1",
            appendPrompt: true,
          },
          { id: "cmd-2", name: "echo", argv: ["echo"], providerId: "missing", appendPrompt: false },
          {
            id: "cmd-3",
            name: "standalone",
            argv: ["standalone"],
            providerId: null,
            appendPrompt: false,
          },
        ],
      },
      "/api/v1/providers": { items: [{ id: "p-1", name: "Claude" }] },
    });
    const html = await renderPage(CommandsPage());
    expect(html).toContain('data-pw="page-commands"');
    expect(html).toContain('href="/commands/cmd-1"');
    expect(html).toContain("Claude");
    expect(html).toContain("tool --prompt");
    expect(html).toContain("yes");
  });

  it("renders empty commands and an API error", async () => {
    stubApi({
      "/api/v1/commands": {},
      "/api/v1/providers": {},
    });
    let html = await renderPage(CommandsPage());
    expect(html).toContain("No commands registered yet.");
    stubApi({
      "/api/v1/commands": "__throw_string__",
      "/api/v1/providers": { items: [] },
    });
    html = await renderPage(CommandsPage());
    expect(html).toContain("offline");
    stubApi({
      "/api/v1/commands": jsonResponse({}, 503),
      "/api/v1/providers": { items: [] },
    });
    html = await renderPage(CommandsPage());
    expect(html).toContain("GET /api/v1/commands");
  });

  it("renders providers with account, cooldown, and command counts", async () => {
    stubApi({
      "/api/v1/providers": {
        items: [
          { id: "p-1", name: "Claude", defaultCommandId: "cmd-1" },
          { id: "p-2", name: "Empty", defaultCommandId: null },
        ],
      },
      "/api/v1/provider-accounts": {
        items: [
          {
            id: "a-1",
            providerId: "p-1",
            label: "work",
            usageLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
          },
          { id: "a-2", providerId: "other", label: "other" },
          { id: "a-3", providerId: "p-1", label: "healthy" },
        ],
      },
      "/api/v1/commands": {
        items: [
          { id: "cmd-1", name: "run", argv: ["tool"], providerId: "p-1", appendPrompt: false },
          { id: "cmd-2", name: "other", argv: ["other"], providerId: "other", appendPrompt: false },
        ],
      },
    });
    const html = await renderPage(ProvidersPage());
    expect(html).toContain('data-pw="page-providers"');
    expect(html).toContain('href="/providers/p-1"');
    expect(html).toContain("(1 paused)");
    expect(html).toContain("Claude");
  });

  it("renders an empty provider catalog and preserves API errors", async () => {
    stubApi({
      "/api/v1/providers": {},
      "/api/v1/provider-accounts": {},
      "/api/v1/commands": {},
    });
    let html = await renderPage(ProvidersPage());
    expect(html).toContain("No providers registered yet.");
    stubApi({
      "/api/v1/providers": "__throw_string__",
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
    });
    html = await renderPage(ProvidersPage());
    expect(html).toContain("offline");
    stubApi({
      "/api/v1/providers": jsonResponse({}, 500),
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
    });
    html = await renderPage(ProvidersPage());
    expect(html).toContain("GET /api/v1/providers");
  });

  it("renders repositories, host choices, and worktree hierarchy", async () => {
    stubApi({
      "/api/v1/repositories": {
        items: [
          { id: "r-1", name: "harness", url: "/src/harness" },
          { id: "r-2", name: "empty", url: "/src/empty" },
          { id: "r-0", name: "empty", url: "/src/empty-copy" },
        ],
      },
      "/api/v1/hosts": { items: [{ hostId: "host-1" }] },
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-1",
            name: "feature",
            repositoryId: "r-1",
            path: "/tmp/feature",
            status: "idle",
            online: true,
            hostId: "host-1",
            labels: ["ready"],
          },
        ],
      },
    });
    const html = await renderPage(RepositoriesPage());
    expect(html).toContain('data-pw="page-repositories"');
    expect(html).toContain('data-pw="repo-link-r-1"');
    expect(html).toContain("feature");
    expect(html).toContain("Attach a repository to a host");
    expect(html.indexOf('data-pw="repo-link-r-2"')).toBeLessThan(
      html.indexOf('data-pw="repo-link-r-1"'),
    );
    expect(html.indexOf('data-pw="repo-link-r-0"')).toBeLessThan(
      html.indexOf('data-pw="repo-link-r-2"'),
    );
  });

  it("renders an empty repository hierarchy and API failure", async () => {
    stubApi({
      "/api/v1/repositories": {},
      "/api/v1/hosts": {},
      "/api/v1/worktrees": {},
    });
    let html = await renderPage(RepositoriesPage());
    expect(html).toContain("No repositories configured");
    expect(html).toContain('data-pw="repositories-empty-add"');
    stubApi({
      "/api/v1/repositories": "__throw_string__",
      "/api/v1/hosts": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    html = await renderPage(RepositoriesPage());
    expect(html).toContain("offline");
    stubApi({
      "/api/v1/repositories": jsonResponse({}, 502),
      "/api/v1/hosts": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    html = await renderPage(RepositoriesPage());
    expect(html).toContain("GET /api/v1/repositories");
  });
});
