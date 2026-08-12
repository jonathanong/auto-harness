import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorktreesHierarchy, groupWorktreesByRepo } from "./worktrees-hierarchy.tsx";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}

const worktree = {
  id: "worktree/a",
  name: "feature-a",
  repositoryId: "repo/a",
  path: "/worktrees/a",
  status: "running",
  online: true,
  hostId: "host/a",
  labels: ["fast", "linux"],
};

const changingLabels = {
  ...worktree,
  id: "worktree/b",
  name: "b",
  status: undefined,
  online: undefined,
  hostId: undefined,
};
let labelsRead = 0;
Object.defineProperty(changingLabels, "labels", {
  enumerable: true,
  get: () => (++labelsRead === 1 ? ["first-read"] : undefined),
});

describe("shared worktree hierarchy", () => {
  it("renders empty and populated groups with conditional actions, links, and table columns", () => {
    expect(
      render(<WorktreesHierarchy groups={[]} emptyMessage="No matching worktrees" />),
    ).toContain("No matching worktrees");
    const grouped = groupWorktreesByRepo([
      worktree,
      { ...worktree, id: "worktree/b", name: "feature-b", repositoryId: "repo/b", labels: [] },
      { ...worktree, id: "worktree/c", name: "feature-c", repositoryId: "repo/a" },
    ]);
    expect(grouped.map((group) => group.repositoryId)).toEqual(["repo/a", "repo/b"]);
    expect(grouped[0]?.worktrees).toHaveLength(2);
    const rich = render(
      <WorktreesHierarchy
        showHost
        hrefBase="/worktrees"
        renderRepoActions={(group) => <button type="button">Add to {group.repositoryId}</button>}
        renderWorktreeActions={(item) => <button type="button">Remove {item.id}</button>}
        groups={[
          {
            repositoryId: "repo/a",
            repositoryName: "Repository A",
            repoPath: "/repos/a",
            repoHrefBase: "/repositories",
            worktrees: [worktree, changingLabels],
          },
          { repositoryId: "repo/empty", repoHrefBase: "/repositories", worktrees: [] },
        ]}
      />,
    );
    expect(rich).toContain('data-pw="worktrees-hierarchy"');
    expect(rich).toContain('href="/repositories/repo%2Fa"');
    expect(rich).toContain('href="/repositories/repo%2Fempty"');
    expect(rich).toContain('href="/worktrees/worktree%2Fa"');
    expect(rich).toContain("Add to repo/a");
    expect(rich).toContain("Remove worktree/a");
    expect(rich).toContain("No worktrees under this repository.");
    expect(rich).toContain("host/a");
    expect(rich).toContain('font-mono text-xs">—</td>');
    const plain = render(
      <WorktreesHierarchy
        groups={[
          {
            repositoryId: "repo/plain",
            worktrees: [
              { id: "worktree/plain", name: "plain", repositoryId: "repo/plain", path: "/plain" },
            ],
          },
        ]}
      />,
    );
    expect(plain).toContain("repo/plain");
    expect(plain).toContain("worktree-row-worktree/plain");
  });
});
