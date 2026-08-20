import { describe, expect, it } from "vitest";

import SettingsIndexPage from "./page.tsx";

describe("settings index", () => {
  it("redirects /settings to /settings/account", async () => {
    await expect(SettingsIndexPage()).rejects.toThrow(/NEXT_REDIRECT|\/settings\/account/);
  });
});
