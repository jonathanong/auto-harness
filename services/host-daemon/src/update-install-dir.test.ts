import { describe, expect, it } from "vitest";

import { resolveUpdateInstallDir } from "./update-install-dir.ts";

describe("resolveUpdateInstallDir", () => {
  it("keeps an explicit update root on every platform", () => {
    expect(
      resolveUpdateInstallDir(
        { HARNESS_UPDATE_INSTALL_DIR: " /custom/updates " },
        { platform: "win32" },
      ),
    ).toBe("/custom/updates");
  });

  it("uses stable platform-specific user data defaults", () => {
    expect(resolveUpdateInstallDir({}, { platform: "linux", home: "/home/op" })).toBe(
      "/opt/auto-harness",
    );
    expect(resolveUpdateInstallDir({}, { platform: "darwin", home: "/Users/op" })).toBe(
      "/Users/op/Library/Application Support/auto-harness/updates",
    );
    expect(
      resolveUpdateInstallDir(
        {},
        { platform: "win32", appData: "C:\\Users\\op\\AppData\\Roaming" },
      ),
    ).toBe("C:\\Users\\op\\AppData\\Roaming/auto-harness/updates");
  });

  it("derives a Windows app-data fallback from the configured home", () => {
    expect(resolveUpdateInstallDir({}, { platform: "win32", home: "C:\\Users\\op" })).toBe(
      "C:\\Users\\op/AppData/Roaming/auto-harness/updates",
    );
  });
});
