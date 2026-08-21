import { describe, expect, it } from "vitest";

import SettingsIndexPage from "./page.tsx";

describe("settings index", () => {
  it("redirects /settings to /settings/account", () => {
    expect(() => SettingsIndexPage()).toThrow(/NEXT_REDIRECT|\/settings\/account/);
  });
});
