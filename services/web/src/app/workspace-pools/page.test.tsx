import { afterEach, describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../../../test-helpers/route-test-helpers.tsx";
import WorkspacePoolsPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

describe("workspace pools page", () => {
  it("lists pools, profile names, cleanup policy, and the management form", async () => {
    stubApi({
      "/api/v1/workspace-pools": {
        items: [
          {
            id: "pool-1",
            name: "browser-tests",
            setupProfiles: [{ id: "install", name: "Install dependencies" }],
            destroyWorkspaceAfter: true,
          },
        ],
      },
    });
    const html = await renderPage(WorkspacePoolsPage());
    expect(html).toContain('data-pw="page-workspace-pools"');
    expect(html).toContain('href="/workspace-pools/pool-1"');
    expect(html).toContain("Install dependencies");
    expect(html).toContain('data-pw="form-workspace-pool-create"');
  });

  it("renders an empty catalog and reports an API failure", async () => {
    stubApi({ "/api/v1/workspace-pools": "__throw_string__" });
    const html = await renderPage(WorkspacePoolsPage());
    expect(html).toContain("offline");
    expect(html).toContain("No workspace pools configured.");
  });

  it("withholds the configuration form from a principal without exec-config access", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": {
        username: "viewer",
        role: "read-only",
        kind: "user",
        capabilities: [],
      },
      "/api/v1/workspace-pools": { items: [] },
    });

    const html = await renderPage(WorkspacePoolsPage());

    expect(html).toContain("Workspace-pool changes require");
    expect(html).not.toContain('data-pw="form-workspace-pool-create"');
  });

  it("defaults missing items and renders retained pools without profiles", async () => {
    stubApi({ "/api/v1/workspace-pools": {} });
    expect(await renderPage(WorkspacePoolsPage())).toContain("No workspace pools configured.");

    stubApi({
      "/api/v1/workspace-pools": {
        items: [
          {
            id: "retained",
            name: "retained",
            setupProfiles: [],
            destroyWorkspaceAfter: false,
          },
        ],
      },
    });
    const html = await renderPage(WorkspacePoolsPage());
    expect(html).toContain("retain");
    expect(html).toContain("—");
  });
});
