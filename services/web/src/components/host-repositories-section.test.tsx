// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { HostRepositoriesSection } from "./host-repositories-section.tsx";

describe("HostRepositoriesSection", () => {
  it("shows the empty attach and attached-repository states", () => {
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={{ repositories: [], providerAccounts: [], commandProfiles: {} }}
        namesById={{}}
        unattachedCatalog={[]}
        liveById={{}}
      />,
    );
    expect(field(view.container, "host-repositories-section").textContent).toContain(
      "No unattached catalog repositories",
    );
    expect(field(view.container, "worktrees-empty").textContent).toBe(
      "No repositories attached to this host yet.",
    );
    view.unmount();
  });

  it("renders attached repository actions, catalog-name fallbacks, and live worktree state", () => {
    const inventory = {
      repositories: [
        {
          id: "repo-one",
          path: "/repos/one",
          worktrees: [{ id: "worktree-one", name: "one", path: "/repos/one/wt", labels: ["fast"] }],
        },
        { id: "deleted-repo", path: "/repos/deleted", worktrees: [] },
      ],
      providerAccounts: [],
      commandProfiles: {},
    };
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={inventory}
        namesById={{ "repo-one": "Catalog one" }}
        unattachedCatalog={[{ id: "catalog-repo", name: "Catalog repo" }]}
        liveById={{ "worktree-one": { status: "running", online: true } }}
      />,
    );
    expect(field(view.container, "repo-link-repo-one").textContent).toBe("Catalog one");
    expect(field(view.container, "repo-link-deleted-repo").textContent).toBe("deleted-repo");
    expect(field(view.container, "worktree-row-worktree-one").textContent).toContain("running");
    expect(field(view.container, "worktree-row-worktree-one").textContent).toContain("Online");
    expect(field(view.container, "add-worktree-open-repo-one")).toBeInstanceOf(HTMLButtonElement);
    expect(field(view.container, "repo-remove-repo-one")).toBeInstanceOf(HTMLButtonElement);
    expect(field(view.container, "worktree-remove-worktree-one")).toBeInstanceOf(HTMLButtonElement);
    expect(field(view.container, "repo-settings-open-repo-one")).toBeInstanceOf(HTMLButtonElement);
    expect(field(view.container, "form-add-local-repo")).toBeInstanceOf(HTMLFormElement);
    expect(field(view.container, "worktree-group-deleted-repo").textContent).toContain(
      "No worktrees under this repository.",
    );
    view.unmount();
  });

  it("shows retryable errors in place of the attach form and alongside worktree status", () => {
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={{ repositories: [], providerAccounts: [], commandProfiles: {} }}
        namesById={{}}
        unattachedCatalog={[]}
        liveById={{}}
        catalogError="GET /api/v1/repositories → 500"
        worktreesError="GET /api/v1/worktrees → 500"
      />,
    );
    expect(field(view.container, "host-repositories-catalog-error").textContent).toContain(
      "Could not load the repository catalog",
    );
    expect(field(view.container, "host-repositories-worktree-status-error").textContent).toContain(
      "Could not load live worktree status",
    );
    view.unmount();
  });
});
