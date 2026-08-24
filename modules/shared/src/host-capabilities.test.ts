import { describe, expect, it } from "vitest";

import {
  defaultMaxConcurrentAssignments,
  hasHostCapability,
  isHostCapability,
  normalizeHostCapabilities,
  parseHostCapabilitiesAdvertisement,
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

  it("parses legacy arrays and nested assignment capacity", () => {
    expect(parseHostCapabilitiesAdvertisement(undefined)).toEqual({ features: [] });
    expect(parseHostCapabilitiesAdvertisement(["scheduled-main-checkout"])).toEqual({
      features: ["scheduled-main-checkout"],
      maxConcurrentAssignments: 64,
    });
    expect(
      parseHostCapabilitiesAdvertisement({
        features: ["scheduled-main-checkout"],
        maxConcurrentAssignments: 4,
      }),
    ).toEqual({
      features: ["scheduled-main-checkout"],
      maxConcurrentAssignments: 4,
    });
    expect(parseHostCapabilitiesAdvertisement({ maxConcurrentAssignments: 2 })).toEqual({
      features: [],
      maxConcurrentAssignments: 2,
    });
    expect(parseHostCapabilitiesAdvertisement(["not-real"])).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({ maxConcurrentAssignments: 0 })).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({ extra: true })).toBeNull();
    expect(parseHostCapabilitiesAdvertisement("scheduled-main-checkout")).toBeNull();
    expect(
      parseHostCapabilitiesAdvertisement({
        features: ["scheduled-main-checkout", "scheduled-main-checkout"],
      }),
    ).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({ maxConcurrentAssignments: 257 })).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({ features: ["not-real"] })).toBeNull();
    expect(
      parseHostCapabilitiesAdvertisement({ features: ["scheduled-main-checkout", "x"] }),
    ).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({ features: "scheduled-main-checkout" })).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({ maxConcurrentAssignments: 1.5 })).toBeNull();
    expect(parseHostCapabilitiesAdvertisement({})).toEqual({
      features: [],
      maxConcurrentAssignments: 64,
    });
    expect(parseHostCapabilitiesAdvertisement({ features: ["scheduled-main-checkout"] })).toEqual({
      features: ["scheduled-main-checkout"],
      maxConcurrentAssignments: 64,
    });
    expect(defaultMaxConcurrentAssignments(undefined)).toBe(64);
    expect(defaultMaxConcurrentAssignments(8)).toBe(8);
  });
});
