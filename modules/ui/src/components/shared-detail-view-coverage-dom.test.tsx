// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorktreesHierarchy } from "./worktrees-hierarchy.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => document.body.replaceChildren());

describe("shared detail hierarchy accessibility", () => {
  it("keeps the expanded group, semantic table, links, and action controls usable", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const view = mount(
      <WorktreesHierarchy
        showHost
        hrefBase="/worktrees"
        renderRepoActions={(group) => (
          <button type="button" onClick={add} aria-label={`Add worktree to ${group.repositoryId}`}>
            Add worktree
          </button>
        )}
        renderWorktreeActions={(item) => (
          <button type="button" onClick={remove} aria-label={`Remove ${item.name}`}>
            Remove
          </button>
        )}
        groups={[
          {
            repositoryId: "repo/a",
            repositoryName: "Repository A",
            repoHrefBase: "/repositories",
            worktrees: [
              {
                id: "worktree/a",
                name: "Feature A",
                repositoryId: "repo/a",
                path: "/worktrees/a",
                status: "running",
                online: true,
                hostId: "host/a",
                labels: ["linux"],
              },
            ],
          },
        ]}
      />,
    );
    const group = view.container.querySelector("details");
    const summary = view.container.querySelector("summary");
    const table = view.container.querySelector("table");
    expect(group?.open).toBe(true);
    expect(summary?.textContent).toContain("Repository A");
    expect(table?.querySelectorAll("th")).toHaveLength(7);
    expect(view.container.querySelector('a[href="/repositories/repo%2Fa"]')?.textContent).toBe(
      "Repository A",
    );
    expect(view.container.querySelector('a[href="/worktrees/worktree%2Fa"]')?.textContent).toBe(
      "Feature A",
    );
    act(() =>
      (
        view.container.querySelector('[aria-label="Add worktree to repo/a"]') as HTMLButtonElement
      ).click(),
    );
    act(() =>
      (
        view.container.querySelector('[aria-label="Remove Feature A"]') as HTMLButtonElement
      ).click(),
    );
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    view.unmount();
  });
});
