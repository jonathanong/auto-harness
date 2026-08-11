import { describe, expect, it } from "vitest";

import { parseHostBody } from "./control-plane-agent-hosts-parse.ts";

describe("host inventory parsing guards", () => {
  it("rejects a missing repository id, a non-array inventory, and an invalid worktree name", () => {
    expect(() =>
      parseHostBody("host-1", {
        repositories: [{ id: "", path: "/repo", worktrees: [] }],
        commandProfiles: {},
      }),
    ).toThrow(/id must be a non-empty string/);
    expect(() =>
      parseHostBody("host-1", { repositories: "not-an-array", commandProfiles: {} }),
    ).toThrow(/repositories must be an array/);
    expect(() =>
      parseHostBody("host-1", {
        repositories: [
          {
            id: "repo-1",
            path: "/repo",
            worktrees: [{ id: "wt-1", name: "not a slug", path: "/repo/wt-1", labels: [] }],
          },
        ],
        commandProfiles: {},
      }),
    ).toThrow(/name must be/);
  });
});
