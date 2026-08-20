import { describe, expect, it } from "vitest";

import { renderPage } from "../route-test-helpers.tsx";
import SettingsLayout from "./layout.tsx";

describe("settings layout", () => {
  it("renders the shared settings chrome around nested pages", async () => {
    const html = await renderPage(SettingsLayout({ children: "nested" }));
    expect(html).toContain('data-pw="page-settings"');
    expect(html).toContain('data-pw="settings-heading"');
    expect(html).toContain("nested");
  });
});
