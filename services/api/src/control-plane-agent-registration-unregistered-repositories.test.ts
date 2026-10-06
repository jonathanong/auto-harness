import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

function worktree(id: string, repositoryId: string, path = `/${repositoryId}/${id}`) {
  return { id, name: id, path, labels: [], repositoryId };
}

function register(
  plane: ControlPlane,
  repositories: Array<{ id: string; path: string }>,
  worktrees: Array<ReturnType<typeof worktree>>,
) {
  return plane.registerHost({
    hostId: "host",
    repositories: repositories.map((repository) => ({ ...repository, defaultBranch: "main" })),
    worktrees,
    replaceExisting: true,
  });
}

function shape(plane: ControlPlane) {
  return plane.getHostInventory("host")?.repositories.map((repository) => ({
    id: repository.id,
    path: repository.path,
    worktrees: repository.worktrees.map((item) => item.id),
  }));
}

const A = { id: "a", path: "/a" };
const B = { id: "b", path: "/b" };

function seeded() {
  const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
  expect(register(plane, [A, B], [worktree("a1", "a"), worktree("b1", "b")]).ok).toBe(true);
  expect(
    plane.putHostInventory("host", {
      repositories: [
        {
          id: "a",
          path: "/a",
          defaultBranch: "main",
          worktrees: [{ id: "a1", name: "a1", path: "/a/a1", labels: [] }],
        },
        {
          id: "b",
          path: "/b",
          defaultBranch: "trunk",
          worktrees: [
            { id: "b1", name: "b1", path: "/b/b1", labels: ["operator"] },
            { id: "b2", name: "b2", path: "/b/b2", labels: [] },
          ],
        },
      ],
    } as never).ok,
  ).toBe(true);
  return plane;
}

describe("host registration keeps configured repositories it does not register", () => {
  it("retains an omitted repository with its worktrees and settings", () => {
    const plane = seeded();

    expect(register(plane, [A], [worktree("a1", "a")]).ok).toBe(true);

    expect(shape(plane)).toEqual([
      { id: "a", path: "/a", worktrees: ["a1"] },
      { id: "b", path: "/b", worktrees: ["b1", "b2"] },
    ]);
    const kept = plane.getHostInventory("host")?.repositories[1];
    expect(kept?.defaultBranch).toBe("trunk");
    expect(kept?.worktrees[0]?.labels).toEqual(["operator"]);
  });

  it("does not make a retained repository schedulable", () => {
    const plane = seeded();
    expect(register(plane, [A], [worktree("a1", "a")]).ok).toBe(true);
    expect(plane.state.connections.get("connection")?.repositoryIds).toEqual(["a"]);
    // Rows already projected for the omitted repository are offline, so placement skips them.
    expect(plane.state.worktrees.get("b1")?.online).toBe(false);
    expect(plane.state.worktrees.get("a1")?.online).toBe(true);
  });

  it("replaces a retained repository the daemon re-registered at the same path", () => {
    const plane = seeded();
    expect(register(plane, [A, { id: "b2", path: "/b" }], [worktree("a1", "a")]).ok).toBe(true);
    expect(shape(plane)?.map((repository) => repository.id)).toEqual(["a", "b2"]);
  });

  it("drops retained worktrees the daemon now advertises under another repository", () => {
    const plane = seeded();
    expect(register(plane, [A], [worktree("a1", "a"), worktree("b1", "a", "/b/b1")]).ok).toBe(true);
    expect(shape(plane)).toEqual([
      { id: "a", path: "/a", worktrees: ["a1", "b1"] },
      { id: "b", path: "/b", worktrees: ["b2"] },
    ]);
  });

  it("still removes a repository through an explicit inventory edit", () => {
    const plane = seeded();
    expect(
      plane.putHostInventory("host", {
        repositories: [{ id: "a", path: "/a", defaultBranch: "main", worktrees: [] }],
      } as never).ok,
    ).toBe(true);
    expect(register(plane, [A], []).ok).toBe(true);
    expect(shape(plane)).toEqual([{ id: "a", path: "/a", worktrees: [] }]);
  });
});
