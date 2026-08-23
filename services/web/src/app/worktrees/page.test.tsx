import { describe, expect, it } from "vitest";

import { jsonResponse, renderPage, stubApi } from "../route-test-helpers.tsx";
import WorktreesPage from "./page.tsx";

describe("worktrees page", () => {
  it("renders add-worktree from host inventories", async () => {
    stubApi({
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-1",
            name: "feature",
            repositoryId: "r-1",
            path: "/tmp/feature",
            hostId: "host-1",
          },
        ],
      },
      "/api/v1/repositories": { items: [{ id: "r-1", name: "Repo" }] },
      "/api/v1/host-inventories": {
        items: [
          {
            hostId: "host-1",
            repositories: [{ id: "r-1", path: "/src", defaultBranch: "main", worktrees: [] }],
          },
        ],
      },
    });
    const html = await renderPage(WorktreesPage());
    expect(html).toContain('data-pw="page-worktrees"');
    expect(html).toContain('data-pw="add-worktree-open-r-1"');
  });

  it("keeps the list when inventories fail and reports a worktrees API error", async () => {
    stubApi({
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-1",
            name: "feature",
            repositoryId: "r-1",
            path: "/tmp/feature",
            hostId: "host-1",
          },
        ],
      },
      "/api/v1/repositories": { items: [{ id: "r-1", name: "Repo" }] },
      "/api/v1/host-inventories": jsonResponse({}, 500),
    });
    let html = await renderPage(WorktreesPage());
    expect(html).toContain("Unable to load host inventories.");
    expect(html).not.toContain("add-worktree-need-host-r-1");
    expect(html).not.toContain("add-worktree-open-r-1");
    stubApi({
      "/api/v1/worktrees": "__throw_string__",
      "/api/v1/repositories": { items: [] },
    });
    html = await renderPage(WorktreesPage());
    expect(html).toContain("offline");
  });

  it("uses empty API defaults, repository ids, and primitive inventory errors", async () => {
    stubApi({
      "/api/v1/worktrees": {
        items: [
          {
            id: "wt-orphan",
            name: "orphan",
            repositoryId: "missing-repo",
            path: "/tmp/orphan",
          },
        ],
      },
      "/api/v1/repositories": {},
      "/api/v1/host-inventories": "__throw_string__",
    });
    let html = await renderPage(WorktreesPage());
    expect(html).toContain("missing-repo");
    expect(html).toContain("Unable to load host inventories.");

    stubApi({
      "/api/v1/worktrees": {},
      "/api/v1/repositories": {},
      "/api/v1/host-inventories": {},
    });
    html = await renderPage(WorktreesPage());
    expect(html).toContain("No worktrees registered yet.");
  });
});
