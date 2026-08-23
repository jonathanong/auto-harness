/* eslint-disable max-lines -- host list route states share one API fixture. */
import { afterEach, describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../route-test-helpers.tsx";
import HostsPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

describe("hosts fleet route", () => {
  it("groups detailed worktrees and connection time under their host", async () => {
    stubApi({
      "/api/v1/hosts": {
        items: [
          {
            hostId: "host/a",
            online: true,
            gitReady: true,
            connectedAt: "2026-08-12T00:00:00.000Z",
            daemonStartedAt: "2026-08-11T23:00:00.000Z",
            restartCount: 2,
            lastRestartDetectedAt: "2026-08-12T00:30:00.000Z",
          },
          {
            hostId: "single",
            online: true,
            connectedAt: "2026-08-12T01:00:00.000Z",
            restartCount: 1,
          },
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
    expect(html).toContain("Ready");
    expect(html).toContain('data-pw="host-connected-at-host/a"');
    expect(html).toContain('dateTime="2026-08-12T00:00:00.000Z"');
    // Restart count and daemon start time moved to the host detail page's Overview tab (#17) —
    // the fleet list only needs online/offline, not restart-observability detail.
    expect(html).not.toContain("restart");
    expect(html).not.toContain("host-daemon-started-at");
    expect(html).toContain('data-pw="hosts-retained-data-notice"');
    expect(html).toContain("teardown");
    expect(html).toContain("purge");
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
    expect(html).toContain('data-pw="hosts-retained-data-notice"');
  });

  it("filters offline hosts and tolerates legacy list responses without items", async () => {
    stubApi({
      "/api/v1/hosts": {
        items: [
          { hostId: "online", online: true },
          { hostId: "offline", online: false },
        ],
      },
      "/api/v1/host-inventories": {},
      "/api/v1/worktrees": {},
    });
    const html = await renderPage(
      HostsPage({ searchParams: Promise.resolve({ online: "offline", ignored: ["array"] }) }),
    );
    expect(html).toContain('data-pw="host-row-offline"');
    expect(html).not.toContain('data-pw="host-row-online"');

    stubApi({
      "/api/v1/hosts": {},
      "/api/v1/host-inventories": {},
      "/api/v1/worktrees": {},
    });
    expect(await renderPage(HostsPage({ searchParams: Promise.resolve({}) }))).toContain(
      "Add a host above or start a daemon.",
    );
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

  it("keeps host management available when worktree details fail", async () => {
    stubApi({
      "/api/v1/hosts": { items: [{ hostId: "still-visible", online: true }] },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": new Error("worktrees unavailable"),
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="host-row-still-visible"');
    expect(html).toContain('data-pw="host-drain-still-visible"');
    expect(html).toContain("No worktrees configured.");
    expect(html).not.toContain("worktrees unavailable");
    expect(html).not.toContain('data-pw="hosts-retained-data-notice"');
  });

  it("does not show leftover-data notice when every host is online", async () => {
    stubApi({
      "/api/v1/hosts": {
        items: [
          { hostId: "online-a", online: true },
          { hostId: "online-b", online: true },
        ],
      },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="host-row-online-a"');
    expect(html).toContain('data-pw="host-row-online-b"');
    expect(html).not.toContain('data-pw="hosts-retained-data-notice"');
    expect(html).toContain('data-pw="form-add-host"');
  });

  it("does not render Add host for an operator when authentication is required", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "operator", role: "operator", kind: "user" },
      "/api/v1/hosts": { items: [] },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="page-hosts"');
    expect(html).not.toContain('data-pw="form-add-host"');
    expect(html).not.toContain("Add host");
    expect(html).not.toContain("Add a host slot");
    expect(html).toContain("Use an existing host slot");
    expect(html).toContain("No hosts match filters.");
    expect(html).not.toContain("Add a host above");
  });

  it("renders Add host for an unscoped admin when authentication is required", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "admin", role: "admin", kind: "admin" },
      "/api/v1/hosts": { items: [] },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="form-add-host"');
    expect(html).toContain("Add a host above or start a daemon.");
  });

  it("shows Add host for a repository-scoped admin (fleet maintainer)", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": {
        username: "repo-admin",
        role: "admin",
        kind: "user",
        allowedRepositoryIds: ["repo-1"],
      },
      "/api/v1/hosts": { items: [] },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="form-add-host"');
  });

  it("hides Add host for a host-bound admin (daemon identity)", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": {
        username: "host-admin",
        role: "admin",
        kind: "user",
        boundHostId: "host-1",
      },
      "/api/v1/hosts": { items: [] },
      "/api/v1/host-inventories": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(HostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('data-pw="form-add-host"');
  });
});
