import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";

describe("install-service win32 validation", () => {
  it("refuses an invalid existing env before filesystem or task mutation", () => {
    const envPath = "/Users/op/AppData/Roaming/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=REPLACE_WITH_BOUND_HOST_ID\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
    });
    const before = new Map(fs.files);
    const spawn = recorder();
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({ platform: "win32", fs, run: spawn.run, error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/HARNESS_HOST_ID/);
    expect(errors.join("\n")).not.toContain("REPLACE_WITH_BOUND_HOST_ID");
    expect(spawn.calls).toEqual([]);
    expect(fs.files).toEqual(before);
  });
});
