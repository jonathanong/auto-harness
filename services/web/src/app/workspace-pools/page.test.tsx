import { describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../../../test-helpers/route-test-helpers.tsx";
import WorkspacePoolsPage from "./page.tsx";

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
});
