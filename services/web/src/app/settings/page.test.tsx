import { describe, expect, it } from "vitest";

import SettingsIndexPage from "./page.tsx";

describe("settings index", () => {
  it("redirects /settings to /settings/account", async () => {
    await expect(SettingsIndexPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      /NEXT_REDIRECT|\/settings\/account/,
    );
  });

  it("forwards the bounded Slack OAuth result to Slack settings", async () => {
    await expect(
      SettingsIndexPage({ searchParams: Promise.resolve({ slackOAuth: "success" }) }),
    ).rejects.toThrow(/NEXT_REDIRECT|\/settings\/slack\?slackOAuth=success/);
  });

  it("forwards OAuth errors but sends omitted and malformed values to account settings", async () => {
    await expect(
      SettingsIndexPage({ searchParams: Promise.resolve({ slackOAuth: "error" }) }),
    ).rejects.toThrow(/NEXT_REDIRECT|\/settings\/slack\?slackOAuth=error/);
    await expect(
      SettingsIndexPage({ searchParams: Promise.resolve({ slackOAuth: ["success"] }) }),
    ).rejects.toThrow(/NEXT_REDIRECT|\/settings\/account/);
    await expect(SettingsIndexPage({})).rejects.toThrow(/NEXT_REDIRECT|\/settings\/account/);
  });
});
