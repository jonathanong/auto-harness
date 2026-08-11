import { describe, expect, it } from "vitest";

import { safeSettingsReturnPath } from "./settings-page-client.tsx";

describe("settings login return path", () => {
  it("keeps relative settings paths and rejects open redirects", () => {
    expect(safeSettingsReturnPath("/settings", "?tab=slack")).toBe("/settings?tab=slack");
    expect(safeSettingsReturnPath("//evil.example/", "")).toBe("/settings");
    expect(safeSettingsReturnPath("/settings\\evil", "")).toBe("/settings");
    expect(safeSettingsReturnPath("https://evil.example/", "")).toBe("/settings");
  });
});
