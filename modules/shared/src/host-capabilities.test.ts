import { describe, expect, it } from "vitest";

import {
  hasHostCapability,
  isHostCapability,
  normalizeHostCapabilities,
} from "./host-capabilities.ts";

describe("host capabilities", () => {
  it("recognizes the supported capability and treats absent advertisements as unsupported", () => {
    expect(isHostCapability("scheduled-main-checkout")).toBe(true);
    expect(isHostCapability("future-capability")).toBe(false);
    expect(normalizeHostCapabilities(undefined)).toEqual([]);
    expect(hasHostCapability(undefined, "scheduled-main-checkout")).toBe(false);
    expect(isHostCapability(null)).toBe(false);
    expect(hasHostCapability(["scheduled-main-checkout"], "scheduled-main-checkout")).toBe(true);
  });

  it("deduplicates capability advertisements into stable storage order", () => {
    expect(
      normalizeHostCapabilities(["scheduled-main-checkout", "scheduled-main-checkout"]),
    ).toEqual(["scheduled-main-checkout"]);
  });
});
