import { createCipheriv, createHash, randomBytes } from "node:crypto";
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
    expect(() => parseListPageQuery(new URL("http://x/list?limit=foo"))).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => parseListPageQuery(new URL("http://x/list?limit=0"))).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => parseListPageQuery(new URL("http://x/list?limit=101"))).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => parseListPageQuery(new URL("http://x/list?cursor="))).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => parseListPageQuery(new URL("http://x/list?cursor=&cursor=a"))).toThrow(
      InvalidListPageQueryError,
    );
  });
});

describe("storage cursors", () => {
  const secret = "test-storage-cursor-secret";

  function encryptBody(body: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return `s1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
  }

  it("round-trips an ExclusiveStartKey and rejects a tampered value", () => {
    const encoded = encodeStorageCursor({ id: "wt-1" }, secret);
    expect(encoded).toMatch(/^s1\./);
    expect(encoded).not.toContain(Buffer.from('"id":"wt-1"', "utf8").toString("base64url"));
    expect(decodeStorageCursor(encoded, secret)).toEqual({ id: "wt-1" });
    expect(encodeStorageCursor(null, secret)).toBeNull();
    expect(decodeStorageCursor(null, secret)).toBeUndefined();
    expect(() => decodeStorageCursor("wt-1", secret)).toThrow(InvalidListPageQueryError);
    expect(() => decodeStorageCursor("s1.short", secret)).toThrow(InvalidListPageQueryError);
    expect(() => decodeStorageCursor(encoded, "other-secret")).toThrow(InvalidListPageQueryError);
    const scoped = encodeStorageCursor({ id: "wt-1" }, secret, {
      hostId: "host-a",
      repositoryId: "repo-1",
    });
    expect(
      decodeStorageCursor(scoped, secret, { hostId: "host-a", repositoryId: "repo-1" }),
    ).toEqual({ id: "wt-1" });
    expect(() =>
      decodeStorageCursor(encoded, secret, { hostId: "host-a", repositoryId: null }),
    ).toThrow(InvalidListPageQueryError);
    expect(() => decodeStorageCursor(encryptBody(null), secret)).toThrow(InvalidListPageQueryError);
    expect(() => decodeStorageCursor(encryptBody("not-json"), secret)).toThrow(
      InvalidListPageQueryError,
    );
    expect(() => decodeStorageCursor(encryptBody([]), secret)).toThrow(InvalidListPageQueryError);
    expect(() =>
      decodeStorageCursor(encryptBody({ hostId: null, repositoryId: null }), secret),
    ).toThrow(InvalidListPageQueryError);
    expect(() =>
      decodeStorageCursor(encryptBody({ key: [], hostId: null, repositoryId: null }), secret),
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
