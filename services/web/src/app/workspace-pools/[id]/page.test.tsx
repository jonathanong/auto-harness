import { afterEach, describe, expect, it } from "vitest";

import { jsonResponse, renderPage, stubApi } from "../../../../test-helpers/route-test-helpers.tsx";
import WorkspacePoolPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

describe("workspace pool detail page", () => {
  it("renders the editable pool configuration and delete action", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    stubApi({
      "/api/v1/workspace-pools/pool%2F1/exec-config": {
        id: "pool/1",
        name: "browser-tests",
        setupProfiles: [{ id: "install", name: "Install", script: "pnpm install" }],
        defaultSetupProfileId: "install",
        destroyWorkspaceAfter: true,
      },
    });
    const html = await renderPage(WorkspacePoolPage({ params: Promise.resolve({ id: "pool/1" }) }));
    expect(html).toContain('data-pw="page-workspace-pool-detail"');
    expect(html).toContain("browser-tests");
    expect(html).toContain('data-pw="form-workspace-pool-edit"');
    expect(html).toContain('data-pw="delete-workspace-pool-open"');
  });

  it("shows the permission message without fetching pool configuration", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    const fetch = stubApi({
      "/api/v1/auth/me": {
        username: "viewer",
        role: "read-only",
        kind: "user",
        capabilities: [],
      },
    });
    const html = await renderPage(WorkspacePoolPage({ params: Promise.resolve({ id: "pool-1" }) }));
    expect(html).toContain('data-pw="page-workspace-pool-not-found"');
    expect(html).toContain("requires fleet:exec-config");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("renders a not-found message when an authorized lookup fails", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    stubApi({ "/api/v1/workspace-pools/missing/exec-config": jsonResponse({}, 404) });
    const html = await renderPage(
      WorkspacePoolPage({ params: Promise.resolve({ id: "missing" }) }),
    );
    expect(html).toContain('data-pw="page-workspace-pool-not-found"');
    expect(html).toContain("Workspace pool not found.");
  });
});
