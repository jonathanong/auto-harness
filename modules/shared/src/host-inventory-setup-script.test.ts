import { describe, expect, it } from "vitest";

import { updateHostWorktree } from "./host-inventory.ts";

describe("worktree setup-script inheritance", () => {
  it("removes an explicitly cleared override", () => {
    const inventory = {
      repositories: [
        {
          id: "repo",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [
            { id: "wt", name: "wt", path: "/repo/wt", labels: [], setupScript: "npm ci" },
          ],
        },
      ],
      providerAccounts: [],
    };
    const updated = updateHostWorktree(inventory, "repo", {
      id: "wt",
      name: "wt",
      path: "/repo/wt",
      labels: [],
      setupScript: undefined,
    });

    expect(updated.repositories[0]?.worktrees[0]).not.toHaveProperty("setupScript");
  });
});
