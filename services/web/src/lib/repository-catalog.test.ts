import { describe, expect, it, vi } from "vitest";

import {
  dedupeRepositories,
  loadAllRepositoryPages,
  repositoryPagePath,
} from "./repository-catalog.ts";

describe("repository catalog pagination", () => {
  it("preserves a bounded limit while following opaque cursors", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: "a" }], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [{ id: "a" }, { id: "b" }], nextCursor: null });
    await expect(
      loadAllRepositoryPages(fetchPage, undefined, "/api/v1/repositories?limit=1"),
    ).resolves.toEqual([{ id: "a" }, { id: "b" }]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, "/api/v1/repositories?limit=1");
    expect(fetchPage).toHaveBeenNthCalledWith(2, "/api/v1/repositories?limit=1&cursor=next");
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [], nextCursor: "same" });
    await expect(loadAllRepositoryPages(fetchPage)).rejects.toThrow("cursor repeated");
  });

  it("deduplicates appended UI pages by repository id", () => {
    expect(dedupeRepositories([{ id: "a" }, { id: "a" }, { id: "b" }])).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(repositoryPagePath("next", "/api/v1/repositories?limit=1")).toBe(
      "/api/v1/repositories?limit=1&cursor=next",
    );
    expect(repositoryPagePath(null, "/api/v1/repositories?limit=1&cursor=old")).toBe(
      "/api/v1/repositories?limit=1",
    );
    expect(repositoryPagePath("opaque + cursor", "/api/v1/repositories?limit=1")).toBe(
      "/api/v1/repositories?limit=1&cursor=opaque+%2B+cursor",
    );
  });
});
