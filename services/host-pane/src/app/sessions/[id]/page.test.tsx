import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setApiTransportForTests } from "../../../lib/api.ts";
import {
  renderRoute,
  resetRouteTestState,
  setApiReplies,
  startRouteTestServer,
} from "../../detail-route-test-helpers.ts";
import SessionDetailPage from "./page.tsx";

beforeEach(startRouteTestServer);
afterEach(() => {
  setApiTransportForTests(undefined);
  return resetRouteTestState();
});

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
          { timestampSeq: "b", seq: 2, stream: "stderr", content: "later", timestamp: "two" },
          { timestampSeq: "a", seq: 1, stream: "stdout", content: "first", timestamp: "one" },
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
    expect(done).toContain('data-pw="session-logs-error"');
    expect(done).toContain("Could not load session logs");
    expect(done).not.toContain("No logs yet.");
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

  it("distinguishes a genuine lookup failure from a real 404", async () => {
    setApiReplies({ "/api/v1/sessions/broken": 500 });
    const broken = await renderRoute(
      SessionDetailPage({ params: Promise.resolve({ id: "broken" }) }),
    );
    expect(broken).toContain('data-pw="session-detail-lookup-error"');
    expect(broken).toContain("Could not load session broken");
    expect(broken).not.toContain("No session");
  });

  it("stringifies a non-Error rejection for both the session and logs lookups", async () => {
    setApiTransportForTests(async () => {
      throw "not an Error instance";
    });
    const lookupFailure = await renderRoute(
      SessionDetailPage({ params: Promise.resolve({ id: "broken" }) }),
    );
    expect(lookupFailure).toContain('data-pw="session-detail-lookup-error"');
    expect(lookupFailure).toContain("not an Error instance");

    setApiTransportForTests(async (input) => {
      if (String(input).endsWith("/logs?limit=10000")) throw "logs backend exploded";
      return Response.json({ id: "ok", status: "completed" });
    });
    const logsFailure = await renderRoute(
      SessionDetailPage({ params: Promise.resolve({ id: "ok" }) }),
    );
    expect(logsFailure).toContain('data-pw="session-logs-error"');
    expect(logsFailure).toContain("logs backend exploded");
  });
});
