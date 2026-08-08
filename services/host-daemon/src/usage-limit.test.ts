import { describe, expect, it } from "vitest";

import { detectUsageLimit } from "./usage-limit.ts";

describe("detectUsageLimit", () => {
  it("detects common vendor phrases", () => {
    expect(detectUsageLimit("Error: usage limit exceeded")).toBe(true);
    expect(detectUsageLimit("insufficient_quota")).toBe(true);
    expect(detectUsageLimit("Rate limit reached for model")).toBe(true);
    expect(detectUsageLimit("HTTP 429 Too Many Requests")).toBe(true);
  });

  it("ignores clean output", () => {
    expect(detectUsageLimit("")).toBe(false);
    expect(detectUsageLimit("all tests passed")).toBe(false);
  });
});
