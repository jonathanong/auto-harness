import { describe, expect, it } from "vitest";

import { parseHostInventory } from "./host-inventory-parse.ts";

const valid = {
  setupScript: "source ~/.zshrc",
  allowedRoots: ["/opt/harness"],
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      setupScript: "pnpm install",
      terminalHookScript: "./hook.sh",
      providerAccountOverrides: { account: { enabled: false, commandId: "command" } },
      worktrees: [
        {
          id: "worktree-1",
          name: "runner-1",
          path: "/repo/runner-1",
          labels: ["fast"],
          setupScript: "pnpm build",
          providerAccountOverrides: { account: { enabled: true } },
        },
      ],
    },
  ],
  providerAccounts: [{ providerAccountId: "account", commandId: "command" }],
  capabilities: ["scheduled-main-checkout"],
};

describe("parseHostInventory", () => {
  it("parses every supported inventory field", () => {
    expect(parseHostInventory(valid)).toEqual(valid);
  });

  it("applies legacy defaults without requiring optional fields", () => {
    expect(
      parseHostInventory({
        repositories: [{ id: "repo", path: "/repo", worktrees: [] }],
      }),
    ).toEqual({
      repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      capabilities: [],
    });
  });

  it("rejects requirement sets that cannot fit in one runtime report", () => {
    expect(() =>
      parseHostInventory({
        requiredEnvironment: Array.from({ length: 256 }, (_, index) => `HOST_${index}`),
        repositories: [
          {
            id: "repo",
            path: "/repo",
            worktrees: [],
            requiredEnvironment: ["REPOSITORY"],
          },
        ],
      }),
    ).toThrow("must contain at most 256 distinct names");
  });

  it.each([
    [null, "body must be an object"],
    [[], "body must be an object"],
    [{ repositories: [], setupScript: 1 }, "setupScript must be a string"],
    [{ repositories: [], allowedRoots: ["relative"] }, "absolute paths"],
    [{}, "repositories must be an array"],
    [{ repositories: [null] }, "repositories[0] must be an object"],
    [{ repositories: [{}] }, "repositories[0]: id must be a non-empty string"],
    [
      { repositories: [{ id: "repo", worktrees: [] }] },
      "repository.repo: path must be a non-empty string",
    ],
    [
      { repositories: [{ id: "repo", path: "/repo" }] },
      "repository.repo.worktrees must be an array",
    ],
    [
      { repositories: [{ id: "repo", path: "/repo", worktrees: [null] }] },
      "repositories.repo.worktrees[0] invalid",
    ],
    [
      { repositories: [{ id: "repo", path: "/repo", worktrees: [{}] }] },
      "worktree[0]: id must be a non-empty string",
    ],
    [
      { repositories: [{ id: "repo", path: "/repo", worktrees: [{ id: "wt" }] }] },
      "worktree.wt: name must be a non-empty string",
    ],
    [
      {
        repositories: [{ id: "repo", path: "/repo", worktrees: [{ id: "wt", name: "Not Valid" }] }],
      },
      "worktree.wt.name must be lowercase letters",
    ],
    [
      {
        repositories: [{ id: "repo", path: "/repo", worktrees: [{ id: "wt", name: "wt" }] }],
      },
      "worktree.wt: path must be a non-empty string",
    ],
    [
      {
        repositories: [
          {
            id: "repo",
            path: "/repo",
            worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: "fast" }],
          },
        ],
      },
      "worktree.wt.labels must be a string array",
    ],
    [
      {
        repositories: [
          {
            id: "repo",
            path: "/repo",
            worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: [1] }],
          },
        ],
      },
      "worktree.wt.labels must be a string array",
    ],
    [
      {
        repositories: [
          {
            id: "repo",
            path: "/repo",
            worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: [], setupScript: 1 }],
          },
        ],
      },
      "worktree.wt.setupScript must be a string",
    ],
    [
      { repositories: [{ id: "repo", path: "/repo", worktrees: [], setupScript: 1 }] },
      "repository.repo.setupScript must be a string",
    ],
    [
      {
        repositories: [{ id: "repo", path: "/repo", worktrees: [], terminalHookScript: 1 }],
      },
      "repository.repo.terminalHookScript must be a string",
    ],
    [{ repositories: [], capabilities: "yes" }, "capabilities must be a supported"],
    [
      { repositories: [], capabilities: ["scheduled-main-checkout", "scheduled-main-checkout"] },
      "capabilities must be a supported",
    ],
    [{ repositories: [], capabilities: ["unknown"] }, "capabilities must be a supported"],
  ])("rejects %#", (input, message) => {
    expect(() => parseHostInventory(input)).toThrow(message);
  });
});
