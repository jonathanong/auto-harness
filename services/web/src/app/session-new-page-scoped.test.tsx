import { afterEach, describe, expect, it } from "vitest";

import NewSessionPage from "./sessions/new/page.tsx";
import { renderPage, stubApi } from "../../test-helpers/route-test-helpers.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

describe("new session route for repository-scoped principals", () => {
  it("does not fetch workspace pools or show workspace mode", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    const fetch = stubApi({
      "/api/v1/auth/me": {
        username: "scoped",
        role: "author",
        kind: "user",
        allowedRepositoryIds: ["repo-a"],
      },
      "/api/v1/session-targets": {
        items: [{ kind: "command", id: "command-1", label: "Run" }],
      },
      "/api/v1/repositories": { items: [{ id: "repo-a", name: "alpha" }] },
      "/api/v1/worktrees": { items: [{ online: true, labels: ["gpu"] }] },
      "/api/v1/workspace-pools": "__throw_string__",
    });
    const html = await renderPage(NewSessionPage({ searchParams: Promise.resolve({}) }));
    expect(
      fetch.mock.calls.some((call) => String(call[0]).includes("/api/v1/workspace-pools")),
    ).toBe(false);
    expect(html).not.toContain("workspace pools:");
    expect(html).not.toContain('data-pw="create-session-mode-workspace"');
    expect(html).not.toContain('data-pw="create-session-mode"');
    expect(html).toContain('data-pw="form-create-session"');
    expect(html).toContain('data-pw="create-session-repository-id"');
  });
});
