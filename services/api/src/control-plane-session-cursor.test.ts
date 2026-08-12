import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  decodeSessionCursor,
  encodeSessionCursor,
  InvalidSessionCursorError,
  InvalidSessionListQueryError,
  normalizeLimit,
  normalizeQuery,
  normalizeScope,
  normalizeSort,
  type SessionCursor,
} from "./control-plane-session-cursor.ts";

const state = { sessionCursorSecret: "secret" } as ControlPlaneState;
const base = {
  version: 1 as const,
  sort: "latest" as const,
  query: {
    repositoryId: null,
    status: null,
    hostId: null,
    concurrencyId: null,
    scheduleId: null,
    source: null,
  },
  scope: { repositoryIds: null, hostId: null },
};

describe("session cursor primitives", () => {
  it("normalizes limits, sorts, filters, and scopes", () => {
    expect(normalizeLimit(undefined)).toBe(50);
    expect(normalizeLimit(100)).toBe(100);
    for (const value of [0, -1, 1.5, 101, Number.NaN]) {
      expect(() => normalizeLimit(value)).toThrow(InvalidSessionListQueryError);
    }
    expect(normalizeSort(undefined)).toBe("latest");
    expect(normalizeSort("latest")).toBe("latest");
    expect(normalizeSort("oldest")).toBe("oldest");
    expect(normalizeSort("priority_desc")).toBe("priority_desc");
    expect(normalizeSort("priority_asc")).toBe("priority_asc");
    expect(() => normalizeSort("invalid" as never)).toThrow(InvalidSessionListQueryError);
    expect(normalizeQuery({ status: "all" }).status).toBeNull();
    expect(normalizeQuery({ status: "queued", repositoryId: "repo" })).toMatchObject({
      status: "queued",
      repositoryId: "repo",
    });
    expect(() => normalizeQuery({ status: "bad" })).toThrow(InvalidSessionListQueryError);
    expect(() => normalizeQuery({ source: "bad" })).toThrow(InvalidSessionListQueryError);
    expect(() => normalizeQuery({ hostId: "" })).toThrow(InvalidSessionListQueryError);
    expect(normalizeScope({ repositoryIds: ["b", "a", "a"], hostId: "host" })).toEqual({
      repositoryIds: ["a", "b"],
      hostId: "host",
    });
    expect(normalizeScope(undefined)).toEqual({ repositoryIds: null, hostId: null });
  });

  it("round-trips signed cursors and rejects tampering or mismatches", () => {
    const cursor: SessionCursor = {
      ...base,
      position: { createdAt: "2026-01-01", id: "s1", priority: 3 },
    };
    const encoded = encodeSessionCursor(state, cursor);
    expect(decodeSessionCursor(state, encoded, base)).toEqual(cursor.position);
    expect(() => decodeSessionCursor(state, "bad", base)).toThrow(InvalidSessionCursorError);
    expect(() => decodeSessionCursor(state, `${encoded}x`, base)).toThrow(
      InvalidSessionCursorError,
    );
    expect(() => decodeSessionCursor(state, encoded, { ...base, sort: "oldest" })).toThrow(
      InvalidSessionCursorError,
    );
    const malformed = encodeSessionCursor(state, {
      ...cursor,
      position: { ...cursor.position, priority: NaN },
    });
    expect(() => decodeSessionCursor(state, malformed, base)).toThrow(InvalidSessionCursorError);
    const primitive = encodeSessionCursor(state, null as unknown as SessionCursor);
    expect(() => decodeSessionCursor(state, primitive, base)).toThrow(InvalidSessionCursorError);
    const invalidJson = Buffer.from("{", "utf8").toString("base64url");
    const signature = createHmac("sha256", state.sessionCursorSecret)
      .update(invalidJson)
      .digest("base64url");
    expect(() => decodeSessionCursor(state, `${invalidJson}.${signature}`, base)).toThrow(
      InvalidSessionCursorError,
    );
  });
});
