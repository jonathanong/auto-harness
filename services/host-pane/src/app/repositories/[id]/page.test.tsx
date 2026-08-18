import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inventory,
  renderRoute,
  resetRouteTestState,
  setApiReplies,
  startRouteTestServer,
} from "../../detail-route-test-helpers.ts";
import RepositoryDetailPage from "./page.tsx";

beforeEach(startRouteTestServer);
afterEach(resetRouteTestState);

describe("repository detail route", () => {
  it("renders repository tabs, decoded ids, sessions, and worktree actions", async () => {
    process.env.HARNESS_HOST_ID = "host/one";
    setApiReplies({
      "/api/v1/hosts/host%2Fone/inventory": inventory,
      "/api/v1/worktrees?hostId=host%2Fone": {
        items: [{ id: "wt/one", status: "busy", online: true }],
      },
      "/api/v1/repositories": { items: [{ id: "repo/one", name: "One" }] },
      "/api/v1/sessions?hostId=host%2Fone&limit=100": {
        items: [
          { id: "included", status: "running", repositoryId: "repo/one" },
          { id: "excluded", status: "queued", repositoryId: "repo-two" },
        ],
      },
    });
    const markup = await renderRoute(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "repo/one" }),
        searchParams: Promise.resolve({ tab: "worktrees" }),
      }),
    );
    expect(markup).toContain("One");
    expect(markup).toContain('data-pw="add-worktree-open-repo/one"');
    expect(markup).toContain("/repositories/repo%2Fone?tab=worktrees");
    expect(markup).toContain('data-pw="worktree-link-wt/one"');

    const sessions = await renderRoute(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "repo/one" }),
        searchParams: Promise.resolve({ tab: "sessions" }),
      }),
    );
    expect(sessions).toContain("included");
    expect(sessions).not.toContain("excluded");
  });

  it("keeps repository sessions empty after fetch errors and handles a missing repository", async () => {
    setApiReplies({
      "/api/v1/hosts/local-1/inventory": inventory,
      "/api/v1/worktrees?hostId=local-1": {},
      "/api/v1/repositories": {},
      "/api/v1/sessions?hostId=local-1&limit=100": 500,
    });
    expect(
      await renderRoute(
        RepositoryDetailPage({
          params: Promise.resolve({ id: "repo/one" }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).toContain("No recent sessions for this repository.");
    setApiReplies({
      "/api/v1/hosts/local-1/inventory": inventory,
      "/api/v1/worktrees?hostId=local-1": {},
      "/api/v1/repositories": {},
      "/api/v1/sessions?hostId=local-1&limit=100": {},
    });
    expect(
      await renderRoute(
        RepositoryDetailPage({
          params: Promise.resolve({ id: "repo/one" }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).toContain("No recent sessions for this repository.");
    expect(
      await renderRoute(
        RepositoryDetailPage({
          params: Promise.resolve({ id: "missing/id" }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).toContain("No repository");
  });
});
