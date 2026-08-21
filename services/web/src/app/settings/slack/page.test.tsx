import { describe, expect, it } from "vitest";

import { renderPage } from "../../route-test-helpers.tsx";
import SlackSettingsPage from "./page.tsx";

describe("slack settings page", () => {
  it("mounts the Slack settings client", async () => {
    const html = await renderPage(SlackSettingsPage());
    expect(html).toContain('data-pw="slack-settings-loading"');
  });
});
