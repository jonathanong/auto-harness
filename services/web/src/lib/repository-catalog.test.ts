import { MAX_CURSOR_PAGES } from "@auto-harness/shared";
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

  it("stops after MAX_CURSOR_PAGES instead of walking the catalog unbounded", async () => {
    let page = 0;
    const fetchPage = vi.fn(async () => {
      page += 1;
      return { items: [{ id: String(page) }], nextCursor: String(page) };
    });
    await expect(loadAllRepositoryPages(fetchPage)).rejects.toThrow(
      `pagination exceeded ${MAX_CURSOR_PAGES} pages`,
    );
  });

  it("treats a page without items as empty", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ nextCursor: null });
    await expect(loadAllRepositoryPages(fetchPage)).resolves.toEqual([]);
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
