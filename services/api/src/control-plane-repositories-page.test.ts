import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  InvalidRepositoryCursorError,
  listRepositoriesPage,
} from "./control-plane-repositories-page.ts";

function repository(id: string, name: string) {
  return {
    id,
    name,
    url: `https://example.test/${id}`,
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePlane(): ControlPlane {
  const plane = new ControlPlane({ sessionCursorSecret: "repository-page-test-secret" });
  plane.state.repositories.set("repository-d", repository("repository-d", "charlie"));
  plane.state.repositories.set("repository-c", repository("repository-c", "bravo"));
  plane.state.repositories.set("repository-b", repository("repository-b", "alpha"));
  plane.state.repositories.set("repository-a", repository("repository-a", "alpha"));
  return plane;
}

function makeNumberedPlane(count: number): ControlPlane {
  const plane = new ControlPlane({ sessionCursorSecret: "repository-page-test-secret" });
  for (let index = 0; index < count; index += 1) {
    const id = `repository-${String(index).padStart(3, "0")}`;
    plane.state.repositories.set(id, repository(id, id));
  }
  return plane;
}

describe("listRepositoriesPage", () => {
  it("pages in deterministic name/id order with a replayable cursor", () => {
    const plane = makePlane();
    const first = listRepositoriesPage(plane.state, { limit: 2 });
    expect(first.items.map(({ id }) => id)).toEqual(["repository-a", "repository-b"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = listRepositoriesPage(plane.state, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(({ id }) => id)).toEqual(["repository-c", "repository-d"]);
    expect(second.nextCursor).toBeNull();
  });

  it("applies normalized visibility scope before slicing and binds it to the cursor", () => {
    const plane = makePlane();
    const first = listRepositoriesPage(plane.state, {
      limit: 1,
      scope: { repositoryIds: ["repository-d", "repository-b", "repository-b"] },
    });
    expect(first.items.map(({ id }) => id)).toEqual(["repository-b"]);
    const second = listRepositoriesPage(plane.state, {
      limit: 1,
      cursor: first.nextCursor!,
      scope: { repositoryIds: ["repository-b", "repository-d"] },
    });
    expect(second.items.map(({ id }) => id)).toEqual(["repository-d"]);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      listRepositoriesPage(plane.state, {
        limit: 1,
        cursor: first.nextCursor!,
        scope: { repositoryIds: ["repository-a"] },
      }),
    ).toThrow(InvalidRepositoryCursorError);
  });

  it("defaults to 50, accepts 100, and permits a continuation limit change", () => {
    const defaultPlane = makeNumberedPlane(51);
    const defaultPage = listRepositoriesPage(defaultPlane.state);
    expect(defaultPage.items).toHaveLength(50);
    expect(defaultPage.nextCursor).toEqual(expect.any(String));

    const changedLimit = listRepositoriesPage(defaultPlane.state, {
      limit: 100,
      cursor: defaultPage.nextCursor!,
    });
    expect(changedLimit.items.map(({ id }) => id)).toEqual(["repository-050"]);
    expect(changedLimit.nextCursor).toBeNull();
    expect(
      listRepositoriesPage(defaultPlane.state, { limit: 100, cursor: defaultPage.nextCursor! }),
    ).toEqual(changedLimit);

    const maxPlane = makeNumberedPlane(101);
    const maxPage = listRepositoriesPage(maxPlane.state, { limit: 100 });
    expect(maxPage.items).toHaveLength(100);
    expect(maxPage.nextCursor).toEqual(expect.any(String));
  });

  it("uses the durable repository catalog before paging", async () => {
    const records = [repository("repository-b", "bravo"), repository("repository-a", "alpha")];
    const plane = new ControlPlane({
      sessionCursorSecret: "repository-page-test-secret",
      storage: { listRepositories: async () => records.map((record) => ({ ...record })) } as never,
    });

    await expect(plane.listRepositoriesPageDurable({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "repository-a" }],
      nextCursor: expect.any(String),
    });
  });
});
