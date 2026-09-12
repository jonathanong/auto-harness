import { describe, expect, it } from "vitest";

import { jsonResponse, renderPage, stubApi } from "../../../test-helpers/route-test-helpers.tsx";
import UserSessionsLoading from "./loading.tsx";
import UserSessionsPage from "./page.tsx";

describe("user sessions route", () => {
  it("renders an accessible loading boundary", async () => {
    const html = await renderPage(<UserSessionsLoading />);
    expect(html).toContain('data-pw="user-sessions-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading user sessions…");
  });

  it("lists live browser viewers and the sessions they are watching", async () => {
    stubApi({
      "/api/v1/user-sessions": {
        items: [
          {
            id: "viewer-1",
            userId: "user:alice",
            username: "alice",
            role: "operator",
            kind: "user",
            connectedAt: "2026-09-06T00:00:00.000Z",
            lastHeartbeatAt: "2026-09-06T00:01:00.000Z",
            subscriptions: [{ sessionId: "sess/one", repositoryId: "repo-1", status: "running" }],
          },
          {
            id: "viewer-2",
            userId: "anonymous",
            username: "anonymous",
            role: null,
            kind: "user",
            connectedAt: "2026-09-06T00:02:00.000Z",
            lastHeartbeatAt: "2026-09-06T00:02:00.000Z",
            subscriptions: [],
          },
          {
            id: "viewer-3",
            userId: "user:unknown",
            username: "unknown-role",
            role: "not-a-role",
            kind: "user",
            connectedAt: "2026-09-06T00:03:00.000Z",
            lastHeartbeatAt: "2026-09-06T00:03:00.000Z",
            subscriptions: [],
          },
        ],
      },
    });
    const html = await renderPage(UserSessionsPage());
    expect(html).toContain('data-pw="page-user-sessions"');
    expect(html).toContain('data-pw="user-sessions-heading"');
    expect(html).toContain("User Sessions");
    expect(html).toContain("not host daemons");
    expect(html).toContain('data-pw="user-sessions-table"');
    expect(html).toContain('data-pw="user-session-row-viewer-1"');
    expect(html).toContain('data-pw="user-session-user-viewer-1"');
    expect(html).toContain("alice");
    expect(html).toContain("Operator");
    expect(html).toContain('href="/sessions/sess%2Fone"');
    expect(html).toContain('data-pw="user-session-watch-sess/one"');
    expect(html).toContain('data-pw="user-session-row-viewer-2"');
    expect(html).toContain('data-pw="user-session-role-viewer-2">—');
    expect(html).toContain('data-pw="user-session-row-viewer-3"');
    expect(html).toContain('data-pw="user-session-role-viewer-3">—');
    expect(html).toContain('data-pw="user-session-watching-viewer-2"');
    expect(html).not.toContain('data-pw="user-sessions-empty"');
  });

  it("shows an empty state when no browser viewers are connected", async () => {
    stubApi({ "/api/v1/user-sessions": { items: [] } });
    const html = await renderPage(UserSessionsPage());
    expect(html).toContain('data-pw="user-sessions-empty"');
    expect(html).toContain("No live user sessions");
    expect(html).toContain("Hosts page");
    expect(html).not.toContain('data-pw="user-sessions-table"');
  });

  it("surfaces a user-session list read failure", async () => {
    stubApi({ "/api/v1/user-sessions": jsonResponse({}, 503) });
    const html = await renderPage(UserSessionsPage());
    expect(html).toContain('data-pw="user-sessions-api-error"');
    expect(html).toContain('data-pw="user-sessions-api-retry"');
    expect(html).not.toContain('data-pw="user-sessions-table"');
    expect(html).not.toContain('data-pw="user-sessions-empty"');
  });

  it("treats a missing items array as empty and stringifies primitive failures", async () => {
    stubApi({ "/api/v1/user-sessions": {} });
    let html = await renderPage(UserSessionsPage());
    expect(html).toContain('data-pw="user-sessions-empty"');

    stubApi({ "/api/v1/user-sessions": "__throw_string__" });
    html = await renderPage(UserSessionsPage());
    expect(html).toContain("offline");
    expect(html).toContain('data-pw="user-sessions-api-error"');
  });
});
