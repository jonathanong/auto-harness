import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";
import { LINUX_ENV_DEST } from "./host-service-templates.ts";

describe("install-service linux validation boundary", () => {
  it("refuses an invalid existing env before filesystem or systemd mutation", () => {
    const fs = seededFs({
      [LINUX_ENV_DEST]: "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=http://localhost\n",
    });
    const before = new Map(fs.files);
    const spawn = recorder();
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({ platform: "linux", uid: 0, fs, run: spawn.run, error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/HARNESS_API_URL/);
    expect(errors.join("\n")).not.toContain("localhost");
    expect(spawn.calls).toEqual([]);
    expect(fs.files).toEqual(before);
  });
});
