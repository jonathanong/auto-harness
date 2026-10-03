import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

function worktree(id: string, labels: string[] = []) {
  return { id, name: id, path: `/repo/${id}`, labels };
}

function register(plane: ControlPlane, worktrees: Array<ReturnType<typeof worktree>>) {
  return plane.registerHost({
    hostId: "host",
    repositories: [{ id: "repo", path: "/repo", defaultBranch: "main" }],
    worktrees: worktrees.map((item) => ({ ...item, repositoryId: "repo" })),
    replaceExisting: true,
  });
}

function configuredIds(plane: ControlPlane): string[] {
  return plane.getHostInventory("host")?.repositories[0]?.worktrees.map((item) => item.id) ?? [];
}

describe("host registration keeps configured worktrees it does not advertise", () => {
  it("keeps pending checkouts so the next inventory poll cannot drop them", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(register(plane, [worktree("a"), worktree("b", ["daemon"])]).ok).toBe(true);
    expect(
      plane.putHostInventory("host", {
        repositories: [
          {
            id: "repo",
            path: "/repo",
            defaultBranch: "main",
            worktrees: [worktree("a"), worktree("b", ["operator"]), worktree("c")],
          },
        ],
      }).ok,
    ).toBe(true);

    // A daemon whose b and c checkouts are still materializing advertises only a.
    expect(register(plane, [worktree("a", ["fresh"])]).ok).toBe(true);

    expect(configuredIds(plane)).toEqual(["a", "b", "c"]);
    const stored = plane.state.hostInventories.get("host")?.repositories[0]?.worktrees;
    expect(stored?.[0]).toMatchObject({ id: "a", labels: ["fresh"], daemonLabels: ["fresh"] });
    expect(stored?.[1]).toMatchObject({
      id: "b",
      labels: ["operator"],
      daemonLabels: ["daemon"],
    });
    expect(stored?.[2]).toEqual(worktree("c"));
    expect(plane.getHostInventory("host")?.version).toBe(3);
  });

  it("replaces a configured worktree the daemon re-identified at the same name or path", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(register(plane, [worktree("a"), worktree("b")]).ok).toBe(true);

    expect(
      register(plane, [
        { ...worktree("a2"), path: "/repo/a" },
        { ...worktree("b2"), name: "b" },
      ]).ok,
    ).toBe(true);

    expect(configuredIds(plane)).toEqual(["a2", "b2"]);
  });

  it("does not keep a worktree the daemon now advertises under another repository", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(register(plane, [worktree("a"), worktree("b")]).ok).toBe(true);

    expect(
      plane.registerHost({
        hostId: "host",
        repositories: [
          { id: "repo", path: "/repo", defaultBranch: "main" },
          { id: "other", path: "/other", defaultBranch: "main" },
        ],
        worktrees: [
          { ...worktree("a"), repositoryId: "repo" },
          { ...worktree("b"), repositoryId: "other" },
        ],
        replaceExisting: true,
      }).ok,
    ).toBe(true);

    expect(
      plane.getHostInventory("host")?.repositories.map((repository) => ({
        id: repository.id,
        worktrees: repository.worktrees.map((item) => item.id),
      })),
    ).toEqual([
      { id: "repo", worktrees: ["a"] },
      { id: "other", worktrees: ["b"] },
    ]);
  });
});
