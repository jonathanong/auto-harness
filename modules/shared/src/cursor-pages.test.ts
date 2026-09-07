import { describe, expect, it } from "vitest";

import { collectCursorPages, MAX_CURSOR_PAGES } from "./cursor-pages.ts";

describe("collectCursorPages", () => {
  it("follows continuation cursors until the last page", async () => {
    const paths: string[] = [];
    await expect(
      collectCursorPages<{ id: string }>("/items", async (path) => {
        paths.push(path);
        return path.includes("cursor=")
          ? { items: [{ id: "b" }], nextCursor: null }
          : { items: [{ id: "a" }], nextCursor: "next" };
      }),
    ).resolves.toEqual([{ id: "a" }, { id: "b" }]);
    expect(paths).toEqual(["/items", "/items?cursor=next"]);
  });

  it("stops at MAX_CURSOR_PAGES instead of walking an unbounded catalog", async () => {
    let page = 0;
    await expect(
      collectCursorPages(
        "/items",
        async () => {
          page += 1;
          return { items: [{ id: String(page) }], nextCursor: String(page) };
        },
        2,
      ),
    ).rejects.toThrow("pagination exceeded 2 pages");
    expect(MAX_CURSOR_PAGES).toBe(20);
  });
});
