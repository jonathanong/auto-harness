import { describe, expect, it, vi } from "vitest";

import { navigateBrowser } from "./browser-navigation.ts";

describe("navigateBrowser", () => {
  it("preserves the complete relative target for an authoritative navigation", () => {
    const assign = vi.fn();
    navigateBrowser("/base/worktrees/id?tab=provider-accounts", assign);
    expect(assign).toHaveBeenCalledWith("/base/worktrees/id?tab=provider-accounts");
  });
});
