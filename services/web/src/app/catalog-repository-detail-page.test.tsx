import React from "react";
import { describe, expect, it } from "vitest";

import RepositoryDetailPage from "./repositories/[id]/page.tsx";
import { jsonResponse, renderPage, stubApi } from "./route-test-helpers.tsx";

const noSearch = Promise.resolve({});

describe("control repository detail route", () => {
  it("renders repository sessions, worktrees, host provider accounts, and settings", async () => {
    stubApi({
      "/api/v1/repositories/r-1": {
        id: "r-1",
        name: "harness",
        url: "/src/harness",
        defaultBranch: "main",
        setupScript: "setup",
        terminalHookScript: "finish",
      },
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-1",
            name: "feature",
            repositoryId: "r-1",
            path: "/tmp/feature",
            status: "idle",
            online: false,
            hostId: "host-1",
            labels: [],
          },
        ],
      },
      "/api/v1/sessions?limit=100": {
        items: [
          {
            id: "s-1",
            status: "done",
            repositoryId: "r-1",
            hostId: "host-1",
            targetLabel: "run",
            prompt: "test",
            source: "manual",
          },
        ],
      },
      "/api/v1/host-inventories": { items: [{ hostId: "host-1", repositories: [{ id: "r-1" }] }] },
      "/api/v1/providers": { items: [{ id: "p-1", name: "Claude", defaultCommandId: "cmd-1" }] },
      "/api/v1/provider-accounts": { items: [{ id: "a-1", providerId: "p-1", label: "work" }] },
      "/api/v1/commands": {
        items: [
          { id: "cmd-1", name: "run", argv: ["tool"], providerId: "p-1", appendPrompt: true },
        ],
      },
      "/api/v1/hosts/host-1/inventory": {
        repositories: [{ id: "r-1", path: "/tmp/repo", defaultBranch: "main", worktrees: [] }],
        providerAccounts: [{ providerAccountId: "a-1" }],
        commandProfiles: {},
      },
    });
    for (const tab of [undefined, "worktrees", "provider-accounts", "settings"]) {
      const html = await renderPage(
        RepositoryDetailPage({
          params: Promise.resolve({ id: "r-1" }),
          searchParams: Promise.resolve(tab ? { tab } : {}),
        }),
      );
      expect(html).toContain('data-pw="page-repository-detail"');
      expect(html).toContain("harness");
      if (tab === "worktrees") {
        expect(html).toContain('data-pw="add-worktree-open-r-1"');
      }
    }
  });

  it("renders a repository not-found route and tolerates dependent failures", async () => {
    stubApi({ "/api/v1/repositories/missing": jsonResponse({}, 404) });
    let html = await renderPage(
      RepositoryDetailPage({ params: Promise.resolve({ id: "missing" }), searchParams: noSearch }),
    );
    expect(html).toContain('data-pw="page-repository-detail-not-found"');

    stubApi({
      "/api/v1/repositories/r-2": { id: "r-2", name: null, path: null, url: null },
      "/api/v1/worktrees": {},
      "/api/v1/sessions?limit=100": {},
      "/api/v1/host-inventories": {},
      "/api/v1/providers": jsonResponse({}, 500),
      "/api/v1/provider-accounts": jsonResponse({}, 500),
      "/api/v1/commands": jsonResponse({}, 500),
    });
    html = await renderPage(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "r-2" }),
        searchParams: Promise.resolve({ tab: "provider-accounts" }),
      }),
    );
    expect(html).toContain('data-pw="page-repository-detail"');
    expect(html).toContain("Not attached to any host yet");

    stubApi({
      "/api/v1/repositories/r-3": { id: "r-3", name: "attached", url: "/attached" },
      "/api/v1/worktrees": jsonResponse({}, 500),
      "/api/v1/sessions?limit=100": jsonResponse({}, 500),
      "/api/v1/host-inventories": { items: [{ hostId: "host-3", repositories: [{ id: "r-3" }] }] },
      "/api/v1/providers": { items: [] },
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
      "/api/v1/hosts/host-3/inventory": jsonResponse({}, 500),
    });
    html = await renderPage(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "r-3" }),
        searchParams: Promise.resolve({ tab: "provider-accounts" }),
      }),
    );
    expect(html).toContain('data-pw="repository-provider-accounts-tab"');
    html = await renderPage(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "r-3" }),
        searchParams: Promise.resolve({ tab: "worktrees" }),
      }),
    );
    expect(html).toContain('data-pw="add-worktree-need-host-r-3"');

    stubApi({
      "/api/v1/repositories/r-4": { id: "r-4", name: "inventory-error", url: "/error" },
      "/api/v1/worktrees": { items: [] },
      "/api/v1/sessions?limit=100": { items: [] },
      "/api/v1/host-inventories": jsonResponse({}, 500),
      "/api/v1/providers": { items: [] },
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
    });
    html = await renderPage(
      RepositoryDetailPage({ params: Promise.resolve({ id: "r-4" }), searchParams: noSearch }),
    );
    expect(html).toContain('data-pw="page-repository-detail"');
  });
});
