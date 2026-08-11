import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  renderRoute,
  resetRouteTestState,
  setApiReplies,
  startRouteTestServer,
} from "../../detail-route-test-helpers.ts";
import SessionDetailPage from "./page.tsx";

beforeEach(startRouteTestServer);
afterEach(resetRouteTestState);

describe("session detail route", () => {
  it("renders logs and status-specific actions, including API failures", async () => {
    setApiReplies({
      "/api/v1/sessions/session%2Fone": {
        id: "session/one",
        status: "running",
        repositoryId: "repo/one",
        worktreeId: "wt/one",
      },
      "/api/v1/sessions/session%2Fone/logs?limit=10000": {
        items: [
          { seq: 2, stream: "stderr", content: "later", timestamp: "two" },
          { seq: 1, stream: "stdout", content: "first", timestamp: "one" },
        ],
      },
    });
    const running = await renderRoute(
      SessionDetailPage({ params: Promise.resolve({ id: "session/one" }) }),
    );
    expect(running).toContain('data-pw="session-cancel"');
    expect(running).toContain("first");
    setApiReplies({
      "/api/v1/sessions/done": { id: "done", status: "completed" },
      "/api/v1/sessions/done/logs?limit=10000": 500,
      "/api/v1/sessions/missing": 404,
    });
    const done = await renderRoute(SessionDetailPage({ params: Promise.resolve({ id: "done" }) }));
    expect(done).toContain('data-pw="session-resume"');
    expect(done).toContain("No logs yet.");
    setApiReplies({
      "/api/v1/sessions/empty": { id: "empty", status: "completed" },
      "/api/v1/sessions/empty/logs?limit=10000": {},
      "/api/v1/sessions/missing": 404,
    });
    expect(
      await renderRoute(SessionDetailPage({ params: Promise.resolve({ id: "empty" }) })),
    ).toContain("No logs yet.");
    expect(
      await renderRoute(SessionDetailPage({ params: Promise.resolve({ id: "missing" }) })),
    ).toContain("No session");
  });
});
