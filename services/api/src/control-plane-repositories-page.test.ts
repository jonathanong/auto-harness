import { describe, expect, it, vi } from "vitest";

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
  it("exposes in-memory repository pages through the control-plane facade", () => {
    const plane = makePlane();

    expect(plane.listRepositoriesPage({ limit: 1 })).toMatchObject({
      items: [{ id: "repository-a" }],
      nextCursor: expect.any(String),
    });
  });

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
    const listRepositories = vi.fn(async () => records.map((record) => ({ ...record })));
    const storageListRepositoriesPage = vi.fn(async () => ({
      items: [repository("repository-a", "alpha")],
      nextKey: { id: "repository-a" },
    }));
    const plane = new ControlPlane({
      sessionCursorSecret: "repository-page-test-secret",
      storage: { listRepositories, listRepositoriesPage: storageListRepositoriesPage } as never,
    });

    await expect(plane.listRepositoriesPageDurable({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "repository-a" }],
      nextCursor: expect.any(String),
    });
    expect(listRepositories).not.toHaveBeenCalled();
    expect(storageListRepositoriesPage).toHaveBeenCalledWith({ limit: 1 });
  });

  it("binds scoped storage continuations and omits malformed durable rows", async () => {
    const storageListRepositoriesPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { ...repository("repository-b", "bravo"), admissionState: "corrupt" },
          repository("repository-a", "alpha"),
        ],
        nextKey: { scopeOffset: 2 },
      })
      .mockResolvedValueOnce({
        items: [repository("repository-c", "charlie")],
        nextKey: null,
      });
    const plane = new ControlPlane({
      sessionCursorSecret: "repository-page-test-secret",
      storage: { listRepositoriesPage: storageListRepositoriesPage } as never,
    });
    const scope = { repositoryIds: ["repository-c", "repository-a", "repository-b"] };

    const first = await plane.listRepositoriesPageDurable({ limit: 2, scope });
    expect(first.items).toEqual([
      expect.objectContaining({ id: "repository-a", admissionState: "active" }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      plane.listRepositoriesPageDurable({ limit: 2, scope, cursor: first.nextCursor! }),
    ).resolves.toMatchObject({ items: [{ id: "repository-c" }], nextCursor: null });
    expect(storageListRepositoriesPage).toHaveBeenNthCalledWith(1, {
      limit: 2,
      allowedRepositoryIds: ["repository-a", "repository-b", "repository-c"],
    });
    expect(storageListRepositoriesPage).toHaveBeenNthCalledWith(2, {
      limit: 2,
      startKey: { scopeOffset: 2 },
      allowedRepositoryIds: ["repository-a", "repository-b", "repository-c"],
    });
  });

  it("retains full-list paging compatibility for legacy storage adapters", async () => {
    const listRepositories = vi.fn(async () => [
      repository("repository-b", "bravo"),
      repository("repository-a", "alpha"),
    ]);
    const plane = new ControlPlane({
      sessionCursorSecret: "repository-page-test-secret",
      storage: { listRepositories } as never,
    });

    await expect(plane.listRepositoriesPageDurable({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "repository-a" }],
      nextCursor: expect.any(String),
    });
    expect(listRepositories).toHaveBeenCalledOnce();
  });
});
