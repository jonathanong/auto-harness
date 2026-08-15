import React from "react";
import { describe, expect, it } from "vitest";

import RepositoriesLoading from "./repositories/loading.tsx";
import RepositoriesPage from "./repositories/page.tsx";
import SchedulesLoading from "./schedules/loading.tsx";
import SchedulesPage from "./schedules/page.tsx";
import SessionsLoading from "./sessions/loading.tsx";
import SessionsPage from "./sessions/page.tsx";
import { jsonResponse, renderPage, stubApi } from "./route-test-helpers.tsx";

describe("primary list page states", () => {
  it.each([
    ["sessions", SessionsLoading],
    ["repositories", RepositoriesLoading],
    ["schedules", SchedulesLoading],
  ])("renders an accessible %s loading boundary", async (selector, Loading) => {
    const html = await renderPage(<Loading />);
    expect(html).toContain(`data-pw="${selector}-loading"`);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`Loading ${selector}…`);
  });

  it("replaces the sessions table with a retry alert after an API failure", async () => {
    stubApi({
      "/api/v1/sessions?limit=50": jsonResponse({}, 503),
      "/api/v1/repositories": {},
    });
    const html = await renderPage(SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="sessions-api-error"');
    expect(html).toContain('data-pw="sessions-api-retry"');
    expect(html).not.toContain('data-pw="sessions-table"');
  });

  it("keeps session rows with repository id fallback when the catalog is unavailable", async () => {
    stubApi({
      "/api/v1/sessions?limit=50": {
        items: [{ id: "session-1", status: "queued", repositoryId: "repo-fallback" }],
      },
      "/api/v1/repositories": jsonResponse({}, 503),
    });
    const html = await renderPage(SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="session-row-session-1"');
    expect(html).toContain('data-pw="session-repository-session-1"');
    expect(html).toContain("repo-fallback");
    expect(html).not.toContain('data-pw="sessions-api-error"');
  });

  it("replaces repository content and its dependent form after an API failure", async () => {
    stubApi({
      "/api/v1/repositories": jsonResponse({}, 503),
      "/api/v1/hosts": { items: [] },
      "/api/v1/worktrees": { items: [] },
    });
    const html = await renderPage(RepositoriesPage());
    expect(html).toContain('data-pw="repositories-api-error"');
    expect(html).toContain('data-pw="repositories-api-retry"');
    expect(html).not.toContain("No repositories registered yet.");
    expect(html).not.toContain('data-pw="form-attach-local-repo"');
  });

  it("replaces schedules and its dependent form after an API failure", async () => {
    stubApi({
      "/api/v1/schedules": jsonResponse({}, 503),
      "/api/v1/session-targets": { items: [] },
    });
    const html = await renderPage(SchedulesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="schedules-api-error"');
    expect(html).toContain('data-pw="schedules-api-retry"');
    expect(html).not.toContain("No schedules configured.");
    expect(html).not.toContain('data-pw="form-create-schedule"');
  });
});
