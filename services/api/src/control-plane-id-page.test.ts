import { describe, expect, it } from "vitest";

import {
  decodeStorageCursor,
  encodeStorageCursor,
  InvalidListPageQueryError,
  pageByKey,
  parseListPageQuery,
} from "./control-plane-id-page.ts";

describe("parseListPageQuery", () => {
  it("defaults limit to 50 and accepts a single cursor", () => {
    expect(parseListPageQuery(new URL("http://x/list"))).toEqual({ limit: 50, cursor: null });
    expect(parseListPageQuery(new URL("http://x/list?limit=2&cursor=b"))).toEqual({
      limit: 2,
      cursor: "b",
    });
  });

  it("rejects invalid limits and repeated parameters", () => {
    expect(() => parseListPageQuery(new URL("http://x/list?limit=0"))).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => parseListPageQuery(new URL("http://x/list?limit=101"))).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => parseListPageQuery(new URL("http://x/list?cursor=&cursor=a"))).toThrow(
      InvalidListPageQueryError,
    );
  });
});

describe("storage cursors", () => {
  it("round-trips an ExclusiveStartKey and rejects a tampered value", () => {
    const encoded = encodeStorageCursor({ id: "wt-1" });
    expect(encoded).toMatch(/^s1\./);
    expect(decodeStorageCursor(encoded)).toEqual({ id: "wt-1" });
    expect(decodeStorageCursor(null)).toBeUndefined();
    expect(() => decodeStorageCursor("wt-1")).toThrow(InvalidListPageQueryError);
    expect(() => decodeStorageCursor("s1.not-json")).toThrow(InvalidListPageQueryError);
    expect(() =>
      decodeStorageCursor(`s1.${Buffer.from("[]", "utf8").toString("base64url")}`),
    ).toThrow(InvalidListPageQueryError);
  });
});

describe("pageByKey", () => {
  const items = [{ id: "c" }, { id: "a" }, { id: "b" }];

  it("returns a stable id-ordered page and a continuation cursor", () => {
    const first = pageByKey(items, { limit: 2, cursor: null, key: (item) => item.id });
    expect(first).toEqual({ items: [{ id: "a" }, { id: "b" }], nextCursor: "b" });
    expect(
      pageByKey(items, { limit: 2, cursor: first.nextCursor, key: (item) => item.id }),
    ).toEqual({ items: [{ id: "c" }], nextCursor: null });
  });

  it("continues after a cursor even when that key has been deleted", () => {
    expect(pageByKey(items, { limit: 2, cursor: "a", key: (item) => item.id })).toEqual({
      items: [{ id: "b" }, { id: "c" }],
      nextCursor: null,
    });
  });

  it("uses a caller-supplied compare when ranking keys", () => {
    expect(
      pageByKey(items, {
        limit: 2,
        cursor: null,
        key: (item) => item.id,
        compare: (left, right) => right.id.localeCompare(left.id),
      }),
    ).toEqual({ items: [{ id: "c" }, { id: "b" }], nextCursor: "b" });
  });
});
