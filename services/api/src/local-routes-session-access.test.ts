import { describe, expect, it } from "vitest";

import { canAuthorSessions, canCancelSession } from "./local-routes-session-access.ts";
import type { RouteCtx } from "./local-http.ts";

describe("session access helpers", () => {
  it("allows cancel and authoring when authentication is disabled", () => {
    const ctx = { principal: undefined } as RouteCtx;
    expect(canCancelSession(ctx, { hostId: null })).toBe(true);
    expect(canAuthorSessions(ctx)).toBe(true);
  });

  it("denies cancel when a host-bound principal cannot access the session host", () => {
    const ctx = {
      principal: {
        id: "sa:host-a",
        username: "host-a",
        role: "operator",
        kind: "service-account",
        boundHostId: "host-a",
      },
    } as RouteCtx;
    expect(canCancelSession(ctx, { hostId: "host-b" })).toBe(false);
    expect(canAuthorSessions(ctx)).toBe(false);
  });
});
