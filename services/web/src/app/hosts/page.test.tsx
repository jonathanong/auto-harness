import { describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../route-test-helpers.tsx";
import HostsPage from "./page.tsx";

describe("hosts fleet route", () => {
  it("groups detailed worktrees and connection time under their host", async () => {
    stubApi({
      "/api/v1/hosts": {
        items: [
          { hostId: "host/a", online: true, connectedAt: "2026-08-12T00:00:00.000Z" },
          { hostId: "single", online: true, connectedAt: "2026-08-12T01:00:00.000Z" },
          { hostId: "empty", online: false, connectedAt: null },
        ],
      },
      "/api/v1/host-inventories": {
        items: [{ hostId: "host/a", repositories: [{ id: "repo" }] }],
      },
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt/a",
            name: "Feature A",
            hostId: "host/a",
            repositoryId: "repo/a",
            path: "/tmp/a",
            labels: ["gpu"],
            status: "busy",
            currentSessionId: "session/a",
          },
          {
            id: "wt-b",
            name: "Feature B",
            hostId: "host/a",
            repositoryId: "repo/a",
            path: "/tmp/b",
            status: "idle",
          },
          {
            id: "wt-single",
            name: "Only worktree",
            hostId: "single",
            repositoryId: "repo-single",
            path: "/tmp/single",
            labels: [],
            status: "idle",
          },
        ],
      },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="host-worktrees-host/a"');
    expect(html).toContain("2 worktrees · 1 busy");
    expect(html).toContain("1 worktree · 0 busy");
    expect(html).toContain('href="/worktrees/wt%2Fa"');
    expect(html).toContain('href="/sessions/session%2Fa"');
    expect(html).toContain('href="/repositories/repo%2Fa"');
    expect(html).toContain("gpu");
    expect(html).toContain("Current session: None");
    expect(html).toContain("No worktrees configured.");
    expect(html).toContain('data-pw="host-connected-at-host/a"');
    expect(html).toContain('dateTime="2026-08-12T00:00:00.000Z"');
    expect(html).toContain('data-pw="host-connected-at-empty">—');
  });

  it("keeps the filtered empty result when no hosts match", async () => {
    stubApi({
      "/api/v1/hosts": { items: [{ hostId: "offline", online: false }] },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(
      HostsPage({ searchParams: Promise.resolve({ online: "online" }) }),
    );
    expect(html).toContain("No hosts match filters");
    expect(html).toContain('colSpan="8"');
  });

  it("surfaces a host fleet read failure", async () => {
    stubApi({
      "/api/v1/hosts": new Error("fleet unavailable"),
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("fleet unavailable");
  });
});
