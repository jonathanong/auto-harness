import { describe, expect, it } from "vitest";

import { renderPage } from "../../../../test-helpers/route-test-helpers.tsx";
import SessionLogSettingsPage from "./page.tsx";

describe("session log settings page", () => {
  it("renders the structured session log form", async () => {
    const html = await renderPage(SessionLogSettingsPage());
    expect(html).toContain("session-log-settings-loading");
  });
});
