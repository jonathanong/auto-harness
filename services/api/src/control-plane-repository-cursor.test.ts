import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  InvalidRepositoryCursorError,
  InvalidRepositoryListQueryError,
  normalizeRepositoryLimit,
  normalizeRepositoryScope,
  type RepositoryCursor,
} from "./control-plane-repository-cursor.ts";

const state = { sessionCursorSecret: "secret" } as ControlPlaneState;
const base = {
  version: 1 as const,
  domain: "repositories" as const,
  scope: { repositoryIdsDigest: null },
};

describe("repository cursor primitives", () => {
  it("normalizes bounded limits and repository scopes", () => {
    expect(normalizeRepositoryLimit(undefined)).toBe(50);
    expect(normalizeRepositoryLimit(1)).toBe(1);
    expect(normalizeRepositoryLimit(100)).toBe(100);
    for (const value of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeRepositoryLimit(value)).toThrow(InvalidRepositoryListQueryError);
    }
    expect(normalizeRepositoryScope(undefined)).toEqual({ repositoryIdsDigest: null });
    expect(normalizeRepositoryScope({ repositoryIds: ["b", "a", "a"] })).toEqual({
      repositoryIdsDigest: "BHPvLcDTJKtlnTWAwRNOnYEgNZBcR4H91tUpsMaGDhM",
    });
  });

  it("round-trips signed, domain-separated cursors and rejects invalid inputs", () => {
    const cursor: RepositoryCursor = {
      ...base,
      position: { name: "alpha", id: "repository-a" },
    };
    const encoded = encodeRepositoryCursor(state, cursor);
    expect(decodeRepositoryCursor(state, encoded, base)).toEqual(cursor.position);
    expect(() => decodeRepositoryCursor(state, "bad", base)).toThrow(InvalidRepositoryCursorError);
    expect(() => decodeRepositoryCursor(state, `${encoded}x`, base)).toThrow(
      InvalidRepositoryCursorError,
    );
    expect(() =>
      decodeRepositoryCursor(state, encoded, {
        ...base,
        scope: normalizeRepositoryScope({ repositoryIds: ["repository-a"] }),
      }),
    ).toThrow(InvalidRepositoryCursorError);

    const sessionPayload = Buffer.from(
      JSON.stringify({ ...cursor, domain: "sessions" }),
      "utf8",
    ).toString("base64url");
    const sessionSignature = createHmac("sha256", state.sessionCursorSecret)
      .update(sessionPayload)
      .digest("base64url");
    expect(() =>
      decodeRepositoryCursor(state, `${sessionPayload}.${sessionSignature}`, base),
    ).toThrow(InvalidRepositoryCursorError);

    const invalidJson = Buffer.from("{", "utf8").toString("base64url");
    const invalidJsonSignature = createHmac("sha256", state.sessionCursorSecret)
      .update(`repositories\0${invalidJson}`)
      .digest("base64url");
    expect(() =>
      decodeRepositoryCursor(state, `${invalidJson}.${invalidJsonSignature}`, base),
    ).toThrow(InvalidRepositoryCursorError);

    const primitive = encodeRepositoryCursor(state, null as unknown as RepositoryCursor);
    expect(() => decodeRepositoryCursor(state, primitive, base)).toThrow(
      InvalidRepositoryCursorError,
    );
    const array = encodeRepositoryCursor(state, [] as unknown as RepositoryCursor);
    expect(() => decodeRepositoryCursor(state, array, base)).toThrow(InvalidRepositoryCursorError);

    const malformed = encodeRepositoryCursor(state, {
      ...cursor,
      position: { name: "alpha", id: 1 as unknown as string },
    });
    expect(() => decodeRepositoryCursor(state, malformed, base)).toThrow(
      InvalidRepositoryCursorError,
    );
  });

  it("keeps scoped cursors bounded for large repository allow-lists", () => {
    const repositoryIds = Array.from({ length: 10_000 }, (_, index) => `repository-${index}`);
    const scope = normalizeRepositoryScope({ repositoryIds });
    const cursor: RepositoryCursor = {
      ...base,
      scope,
      position: { name: "alpha", id: "repository-a" },
    };
    const encoded = encodeRepositoryCursor(state, cursor);

    expect(encoded.length).toBeLessThan(500);
    expect(decodeRepositoryCursor(state, encoded, { ...base, scope })).toEqual(cursor.position);
  });
});
