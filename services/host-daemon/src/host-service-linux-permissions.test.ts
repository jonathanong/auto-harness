import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import { baseOpts, seededFs } from "./host-service-test-helpers.ts";
import { LINUX_ENV_DEST } from "./host-service-templates.ts";

describe("install-service linux permissions", () => {
  it("refuses an existing env without reading the root-owned file as non-root", () => {
    const fs = seededFs({
      [LINUX_ENV_DEST]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
    });
    const readFile = fs.readFileSync;
    fs.readFileSync = (path) => {
      if (path === LINUX_ENV_DEST) throw new Error("EACCES");
      return readFile(path);
    };
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({ platform: "linux", uid: 501, fs, error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/rerun install-service with sudo/);
    expect(errors.join("\n")).not.toContain("secret");
  });

  it("refuses a non-root URL update without reading the root-owned file", () => {
    const fs = seededFs({ [LINUX_ENV_DEST]: "root-owned" });
    const readFile = fs.readFileSync;
    fs.readFileSync = (path) => {
      if (path === LINUX_ENV_DEST) throw new Error("EACCES");
      return readFile(path);
    };
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 501,
          fs,
          apiUrl: "https://new.example.com",
          error: (m) => errors.push(m),
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/run install-service with sudo/);
  });
});
