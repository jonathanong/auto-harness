import { describe, expect, it } from "vitest";

import { canAuthorSessions, canCancelSession } from "./local-routes-session-access.ts";
import type { RouteCtx } from "./local-http.ts";

describe("session access helpers", () => {
  it("allows cancel and authoring when authentication is disabled", () => {
    const ctx = { principal: undefined } as RouteCtx;
    expect(canCancelSession(ctx, { hostId: null })).toBe(true);
    expect(canAuthorSessions(ctx)).toBe(true);
  });
});
