import { describe, expect, it } from "vitest";

import { persistSessionDetailTab, resolveSessionDetailTab } from "./session-detail-tab.ts";

describe("resolveSessionDetailTab", () => {
  it("accepts known tabs and falls back to logs", () => {
    expect(resolveSessionDetailTab("logs")).toBe("logs");
    expect(resolveSessionDetailTab("details")).toBe("details");
    expect(resolveSessionDetailTab("prompts")).toBe("prompts");
    expect(resolveSessionDetailTab(["prompts"])).toBe("prompts");
    expect(resolveSessionDetailTab(["nope"])).toBe("logs");
    expect(resolveSessionDetailTab("nope")).toBe("logs");
    expect(resolveSessionDetailTab(undefined)).toBe("logs");
    expect(resolveSessionDetailTab(1)).toBe("logs");
  });
});

describe("persistSessionDetailTab", () => {
  it("is a no-op without a window", () => {
    expect(typeof window).toBe("undefined");
    persistSessionDetailTab("details");
  });
});
