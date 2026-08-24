// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { HostRepositoriesSection } from "./host-repositories-section.tsx";

describe("HostRepositoriesSection", () => {
  it("shows the empty attach and attached-repository states", () => {
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={{ repositories: [], providerAccounts: [] }}
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
          defaultBranch: "main",
          worktrees: [{ id: "worktree-one", name: "one", path: "/repos/one/wt", labels: ["fast"] }],
        },
        { id: "deleted-repo", path: "/repos/deleted", defaultBranch: "main", worktrees: [] },
      ],
      providerAccounts: [],
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
        inventory={{ repositories: [], providerAccounts: [] }}
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

  it("hides attach and mutation controls when the caller cannot write inventory", () => {
    const inventory = {
      repositories: [
        {
          id: "repo-one",
          path: "/repos/one",
          defaultBranch: "main",
          worktrees: [{ id: "worktree-one", name: "one", path: "/repos/one/wt", labels: [] }],
        },
      ],
      providerAccounts: [],
    };
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={inventory}
        namesById={{ "repo-one": "Catalog one" }}
        unattachedCatalog={[{ id: "catalog-repo", name: "Catalog repo" }]}
        liveById={{}}
        canWrite={false}
      />,
    );
    expect(view.container.querySelector('[data-pw="form-add-local-repo"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="add-worktree-open-repo-one"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="repo-remove-repo-one"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="worktree-remove-worktree-one"]')).toBeNull();
    expect(field(view.container, "repo-link-repo-one").textContent).toBe("Catalog one");
    view.unmount();
  });

  it("requires exec-config access to remove inventory that contains executable settings", () => {
    const inventory = {
      repositories: [
        {
          id: "plain-repo",
          path: "/repos/plain",
          defaultBranch: "main",
          worktrees: [{ id: "plain-worktree", name: "plain", path: "/repos/plain/wt", labels: [] }],
        },
        {
          id: "configured-repo",
          path: "/repos/configured",
          defaultBranch: "main",
          setupScript: "pnpm install",
          worktrees: [
            {
              id: "configured-worktree",
              name: "configured",
              path: "/repos/configured/wt",
              labels: [],
              setupScript: "pnpm build",
            },
          ],
        },
      ],
      providerAccounts: [],
    };
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={inventory}
        namesById={{}}
        unattachedCatalog={[]}
        liveById={{}}
        canWrite
        canWriteExecConfig={false}
      />,
    );
    expect(field(view.container, "repo-remove-plain-repo")).toBeInstanceOf(HTMLButtonElement);
    expect(field(view.container, "worktree-remove-plain-worktree")).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(view.container.querySelector('[data-pw="repo-remove-configured-repo"]')).toBeNull();
    expect(
      view.container.querySelector('[data-pw="worktree-remove-configured-worktree"]'),
    ).toBeNull();
    view.unmount();
  });

  it("passes inherited host setup to the repository path gate", () => {
    const view = mountForm(
      <HostRepositoriesSection
        hostId="host"
        inventory={{
          setupScript: "pnpm install",
          repositories: [
            {
              id: "repo-one",
              path: "/repos/one",
              defaultBranch: "main",
              worktrees: [],
            },
          ],
          providerAccounts: [],
        }}
        namesById={{}}
        unattachedCatalog={[]}
        liveById={{}}
        canWrite
        canWriteExecConfig={false}
      />,
    );
    press(field(view.container, "repo-settings-open-repo-one"));
    expect(field<HTMLInputElement>(document, "repo-settings-path-repo-one").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "add-worktree-open-repo-one").disabled).toBe(
      true,
    );
    expect(view.container.querySelector('[data-pw="form-add-local-repo"]')).toBeNull();
    expect(field(view.container, "host-repositories-attach-blocked").textContent).toContain(
      "fleet:exec-config",
    );
    view.unmount();
  });
});
