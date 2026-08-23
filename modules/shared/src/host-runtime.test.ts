import { describe, expect, it } from "vitest";

import { isHostRuntimeReport } from "./host-runtime.ts";

describe("host runtime report", () => {
  it("rejects arrays before inspecting runtime fields", () => {
    expect(isHostRuntimeReport([])).toBe(false);
  });
});
