import { describe, expect, it } from "vitest";

import DashboardPage from "./page.tsx";
import RepositoriesPage from "./repositories/page.tsx";
import SchedulesPage from "./schedules/page.tsx";
import SessionsPage from "./sessions/page.tsx";
import { renderPage, stubApi } from "./route-test-helpers.tsx";

const emptySearchParams = { searchParams: Promise.resolve({}) };

describe("primary control-plane empty states", () => {
  it("renders the documented guidance and accessible actions", async () => {
    stubApi({ "/api/v1/sessions": {}, "/api/v1/hosts": {}, "/api/v1/worktrees": {} });
    let html = await renderPage(DashboardPage());
    expect(html).toContain('data-pw="dashboard-empty-sessions"');
    expect(html).toContain('data-pw="dashboard-empty-add-repository"');
    expect(html).toContain('href="/repositories"');
    expect(html).toContain('data-pw="dashboard-empty-connect-agent"');
    expect(html).toContain('data-pw="dashboard-empty-create-session"');
    expect(html).toContain('data-pw="dashboard-empty-agents"');
    expect(html).toContain('data-pw="dashboard-empty-setup-agent"');

    stubApi({ "/api/v1/sessions?limit=50": {} });
    html = await renderPage(SessionsPage(emptySearchParams));
    expect(html).toContain('data-pw="sessions-empty"');
    expect(html).toContain('data-pw="sessions-empty-create"');
    expect(html).toContain('href="/sessions/new"');

    stubApi({
      "/api/v1/repositories": {},
      "/api/v1/hosts": {},
      "/api/v1/worktrees": {},
    });
    html = await renderPage(RepositoriesPage());
    expect(html).toContain('data-pw="repositories-empty"');
    expect(html).toContain('data-pw="repositories-empty-add"');
    expect(html).toContain("No repositories configured");

    stubApi({ "/api/v1/schedules": {}, "/api/v1/session-targets": {} });
    html = await renderPage(SchedulesPage(emptySearchParams));
    expect(html).toContain('data-pw="schedules-empty"');
    expect(html).toContain('data-pw="schedules-empty-create"');
    expect(html).toContain('href="#schedule-create"');
    expect(html).toContain('id="schedule-create"');
  });

  it("preserves filtered empty results and suppresses onboarding on API failure", async () => {
    stubApi({ "/api/v1/sessions?limit=50&status=failed": {} });
    let html = await renderPage(
      SessionsPage({ searchParams: Promise.resolve({ status: "failed" }) }),
    );
    expect(html).not.toContain('data-pw="sessions-empty"');
    expect(html).toContain("No sessions match filters.");

    stubApi({
      "/api/v1/sessions": "__throw_string__",
      "/api/v1/hosts": {},
      "/api/v1/worktrees": {},
    });
    html = await renderPage(DashboardPage());
    expect(html).toContain("Live updates paused (offline)");
    expect(html).not.toContain('data-pw="dashboard-empty-sessions"');
    expect(html).not.toContain('data-pw="dashboard-empty-agents"');

    stubApi({ "/api/v1/schedules": "__throw_string__", "/api/v1/session-targets": {} });
    html = await renderPage(SchedulesPage(emptySearchParams));
    expect(html).toContain("offline");
    expect(html).not.toContain('data-pw="schedules-empty"');
  });
});
