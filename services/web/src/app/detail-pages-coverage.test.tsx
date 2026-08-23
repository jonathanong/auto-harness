/* eslint-disable max-lines -- detail route states share one API fixture. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, renderPage, stubApi } from "./route-test-helpers.tsx";
import ScheduleDetailPage from "./schedules/[id]/page.tsx";
import SessionDetailPage from "./sessions/[id]/page.tsx";
import WorktreeDetailPage from "./worktrees/[worktreeId]/page.tsx";

const noSearch = Promise.resolve({});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("control detail routes previously omitted from coverage include", () => {
  it("renders session detail, usage, and not-found", async () => {
    stubApi({
      "/api/v1/sessions/s-1": {
        id: "s-1",
        status: "running",
        hostId: "host-1",
        repositoryId: "r-1",
        prompt: "do work",
      },
      "/api/v1/sessions/s-1/logs?limit=10000": {
        items: [{ timestampSeq: "a", seq: 1, stream: "stdout", content: "hi", timestamp: "t" }],
      },
      "/api/v1/sessions/s-1/usage": {
        aggregate: {
          reportCount: 1,
          inputTokens: "1",
          outputTokens: "2",
          totalTokens: "3",
          costMicros: "4",
          costMicrosByCurrency: { USD: "4" },
          currency: "USD",
        },
      },
      "/api/v1/hosts": { items: [{ hostId: "host-1", online: true }] },
    });
    const html = await renderPage(SessionDetailPage({ params: Promise.resolve({ id: "s-1" }) }));
    expect(html).toContain('data-pw="page-session-detail"');
    expect(html).toContain('data-pw="session-usage-input"');

    stubApi({ "/api/v1/sessions/missing": jsonResponse({}, 404) });
    const missing = await renderPage(
      SessionDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    );
    expect(missing).toContain('data-pw="page-session-detail-not-found"');
  });

  it("keeps optional session dependencies and owner cancellation fail-safe", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    stubApi({
      "/api/v1/sessions/s-optional": {
        id: "s-optional",
        status: "running",
        hostId: "host-1",
        repositoryId: "r-1",
        metadata: { createdBy: "author-1" },
      },
      "/api/v1/sessions/s-optional/logs?limit=10000": jsonResponse({}, 503),
      "/api/v1/sessions/s-optional/usage": jsonResponse({}, 404),
      "/api/v1/hosts": jsonResponse({}, 503),
      "/api/v1/auth/me": {
        id: "author-1",
        username: "author",
        role: "author",
        kind: "user",
      },
    });
    let html = await renderPage(
      SessionDetailPage({ params: Promise.resolve({ id: "s-optional" }) }),
    );
    expect(html).toContain("No CLI usage reported.");
    expect(html).toContain('data-pw="session-cancel"');

    stubApi({
      "/api/v1/sessions/s-terminal": {
        id: "s-terminal",
        status: "completed",
        repositoryId: "r-1",
      },
      "/api/v1/sessions/s-terminal/logs?limit=10000": {},
      "/api/v1/sessions/s-terminal/usage": { aggregate: null },
      "/api/v1/auth/me": {
        id: "reader-1",
        username: "reader",
        role: "read-only",
        kind: "user",
      },
    });
    html = await renderPage(SessionDetailPage({ params: Promise.resolve({ id: "s-terminal" }) }));
    expect(html).toContain("No CLI usage reported.");
  });

  it("renders schedule detail, empty history, and not-found", async () => {
    stubApi({
      "/api/v1/schedules/schedule-1": {
        id: "schedule-1",
        repositoryId: "r-1",
        name: "Nightly",
        target: { providerId: "p1" },
        fallbacks: [],
        cron: "0 1 * * *",
        enabled: true,
        timeout: 900,
        queueTtlSeconds: 3600,
        activeSessionId: "s-1",
        concurrencyId: "nightly",
        prompt: "review",
      },
      "/api/v1/session-targets": { items: [{ kind: "provider", id: "p1", label: "Claude" }] },
      "/api/v1/sessions?scheduleId=schedule-1&limit=100": { items: [] },
    });
    const html = await renderPage(
      ScheduleDetailPage({ params: Promise.resolve({ id: "schedule-1" }) }),
    );
    expect(html).toContain('data-pw="page-schedule-detail"');
    expect(html).toContain("Nightly");
    expect(html).toContain("No runs yet.");

    stubApi({ "/api/v1/schedules/missing": jsonResponse({}, 404) });
    const missing = await renderPage(
      ScheduleDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    );
    expect(missing).toContain('data-pw="page-schedule-detail-not-found"');
  });

  it("renders worktree detail and not-found", async () => {
    stubApi({
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-1",
            name: "feature",
            repositoryId: "r-1",
            path: "/tmp/feature",
            hostId: "host-1",
            status: "idle",
            online: true,
            labels: [],
          },
        ],
      },
      "/api/v1/repositories": { items: [{ id: "r-1", name: "Repo", url: "/src/repo" }] },
      "/api/v1/sessions?limit=100": { items: [] },
      "/api/v1/hosts/host-1/inventory": {
        repositories: [
          {
            id: "r-1",
            path: "/src/repo",
            worktrees: [{ id: "wt-1", name: "feature", path: "/tmp" }],
          },
        ],
        providerAccounts: [],
      },
      "/api/v1/providers": { items: [] },
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
    });
    const html = await renderPage(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt-1" }),
        searchParams: noSearch,
      }),
    );
    expect(html).toContain('data-pw="page-worktree-detail"');

    stubApi({ "/api/v1/worktrees": { items: [] } });
    const missing = await renderPage(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "missing" }),
        searchParams: noSearch,
      }),
    );
    expect(missing).toContain('data-pw="page-worktree-detail-not-found"');
  });

  it("renders a hostless worktree with optional lookups unavailable", async () => {
    stubApi({
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-hostless",
            name: "hostless",
            repositoryId: "r-missing",
            path: "/tmp/hostless",
          },
        ],
      },
      "/api/v1/repositories": jsonResponse({}, 503),
      "/api/v1/sessions?limit=100": jsonResponse({}, 503),
      "/api/v1/providers": jsonResponse({}, 503),
      "/api/v1/provider-accounts": jsonResponse({}, 503),
      "/api/v1/commands": jsonResponse({}, 503),
    });
    let html = await renderPage(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt-hostless" }),
        searchParams: Promise.resolve({ tab: ["settings"] }),
      }),
    );
    expect(html).toContain("No recent sessions in this worktree.");
    html = await renderPage(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt-hostless" }),
        searchParams: Promise.resolve({ tab: "provider-accounts" }),
      }),
    );
    expect(html).toContain("Not associated with a host inventory.");
    expect(html).not.toContain('data-pw="remove-worktree-wt-hostless"');

    stubApi({ "/api/v1/worktrees": "__throw_string__" });
    const missing = await renderPage(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt-hostless" }),
        searchParams: noSearch,
      }),
    );
    expect(missing).toContain('data-pw="page-worktree-detail-not-found"');
  });

  it("defaults sparse worktree collections and hides actions after an inventory failure", async () => {
    stubApi({ "/api/v1/worktrees": {} });
    expect(
      await renderPage(
        WorktreeDetailPage({
          params: Promise.resolve({ worktreeId: "missing" }),
          searchParams: noSearch,
        }),
      ),
    ).toContain('data-pw="page-worktree-detail-not-found"');

    stubApi({
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-sparse",
            name: "sparse",
            repositoryId: "repo",
            path: "/tmp/sparse",
            hostId: "host",
          },
        ],
      },
      "/api/v1/repositories": {},
      "/api/v1/sessions?limit=100": {},
      "/api/v1/hosts/host/inventory": jsonResponse({}, 503),
      "/api/v1/providers": {},
      "/api/v1/provider-accounts": {},
      "/api/v1/commands": {},
    });
    const html = await renderPage(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt-sparse" }),
        searchParams: noSearch,
      }),
    );
    expect(html).toContain("No recent sessions in this worktree.");
    expect(html).not.toContain('data-pw="remove-worktree-wt-sparse"');
  });
});
