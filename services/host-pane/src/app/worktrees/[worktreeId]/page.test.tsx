import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inventory,
  renderRoute,
  resetRouteTestState,
  setApiReplies,
  startRouteTestServer,
} from "../../detail-route-test-helpers.ts";
import WorktreeDetailPage from "./page.tsx";

beforeEach(startRouteTestServer);
afterEach(resetRouteTestState);

describe("worktree detail route", () => {
  it("renders settings, sessions, fetch errors, and missing worktrees", async () => {
    process.env.HARNESS_HOST_ID = "host/one";
    setApiReplies({
      "/api/v1/hosts/host%2Fone/inventory": inventory,
      "/api/v1/worktrees": { items: [{ id: "wt/one", hostId: "host/one", status: "idle" }] },
      "/api/v1/repositories": { items: [{ id: "repo/one", name: "One" }] },
      "/api/v1/sessions?hostId=host%2Fone&limit=100": {
        items: [
          { id: "included", status: "running", worktreeId: "wt/one" },
          { id: "excluded", status: "queued", worktreeId: "wt-two" },
        ],
      },
    });
    const settings = await renderRoute(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt/one" }),
        searchParams: Promise.resolve({ tab: "settings" }),
      }),
    );
    expect(settings).toContain("Repository path");
    expect(settings).toContain("/repositories/repo%2Fone?tab=worktrees");
    const sessions = await renderRoute(
      WorktreeDetailPage({
        params: Promise.resolve({ worktreeId: "wt/one" }),
        searchParams: Promise.resolve({ tab: "sessions" }),
      }),
    );
    expect(sessions).toContain("included");
    expect(sessions).not.toContain("excluded");
    setApiReplies({
      "/api/v1/hosts/host%2Fone/inventory": inventory,
      "/api/v1/worktrees": {},
      "/api/v1/repositories": {},
      "/api/v1/sessions?hostId=host%2Fone&limit=100": 500,
    });
    expect(
      await renderRoute(
        WorktreeDetailPage({
          params: Promise.resolve({ worktreeId: "wt/one" }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).toContain("No recent sessions in this worktree.");
    setApiReplies({
      "/api/v1/hosts/host%2Fone/inventory": inventory,
      "/api/v1/worktrees": {},
      "/api/v1/repositories": {},
      "/api/v1/sessions?hostId=host%2Fone&limit=100": {},
    });
    expect(
      await renderRoute(
        WorktreeDetailPage({
          params: Promise.resolve({ worktreeId: "wt/one" }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).toContain("No recent sessions in this worktree.");
    expect(
      await renderRoute(
        WorktreeDetailPage({
          params: Promise.resolve({ worktreeId: "missing/id" }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).toContain("No worktree");
  });
});
