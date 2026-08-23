import { describe, expect, it } from "vitest";

import { addHostWorktree, emptyHostInventory, upsertHostRepository } from "./host-inventory.ts";

describe("host-inventory providerAccounts", () => {
  it("cloneInventory (via any mutation) round-trips providerAccounts", () => {
    const seeded = upsertHostRepository(
      {
        repositories: [],
        providerAccounts: [{ providerAccountId: "acct-1", commandId: "cmd-1" }],
        commandProfiles: {},
      },
      { id: "demo", path: "/repo", defaultBranch: "main" },
    );
    expect(seeded.providerAccounts).toEqual([{ providerAccountId: "acct-1", commandId: "cmd-1" }]);
    // Unrelated mutations (editing a repo path, adding a worktree) must not drop it.
    const edited = upsertHostRepository(seeded, {
      id: "demo",
      path: "/repo2",
      defaultBranch: "main",
    });
    expect(edited.providerAccounts).toEqual([{ providerAccountId: "acct-1", commandId: "cmd-1" }]);
    const withWt = addHostWorktree(edited, "demo", {
      id: "wt-a",
      name: "wt-a",
      path: "/repo2/wt-a",
      labels: [],
    });
    expect(withWt.providerAccounts).toEqual([{ providerAccountId: "acct-1", commandId: "cmd-1" }]);
  });

  it("emptyHostInventory seeds providerAccounts as empty", () => {
    expect(emptyHostInventory().providerAccounts).toEqual([]);
  });

  it("clones repository-level required environment arrays", () => {
    const source = {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          defaultBranch: "main",
          requiredEnvironment: ["TOKEN"],
          worktrees: [],
        },
      ],
      providerAccounts: [],
      capabilities: [],
    };
    const cloned = upsertHostRepository(source, {
      id: "other",
      path: "/other",
      defaultBranch: "main",
    });
    cloned.repositories[0]!.requiredEnvironment!.push("REGION");
    expect(source.repositories[0]!.requiredEnvironment).toEqual(["TOKEN"]);
  });
});
