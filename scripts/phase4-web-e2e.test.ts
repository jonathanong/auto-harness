/**
 * Control-plane UI helpers + URL state (Next.js app: pnpm local:web).
 */
import { describe, expect, it } from "vitest";

import {
  hostListHref,
  parseSessionListState,
  sessionListHref,
} from "../services/web/src/lib/url-state.ts";

describe("phase4 web create UI helpers", () => {
  it("keeps list filters in the URL", () => {
    expect(sessionListHref({ status: "running", q: "x" })).toContain("status=running");
    expect(parseSessionListState(new URLSearchParams("status=failed")).status).toBe("failed");
    expect(hostListHref({ online: "online" })).toBe("/hosts?online=online");
  });
});
