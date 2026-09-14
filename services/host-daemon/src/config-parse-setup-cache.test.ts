import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { valid } from "../test-helpers/config-test-helpers.ts";

describe("parseDaemonConfig setup cache inputs", () => {
  it("parses operator-declared setup cache inputs", () => {
    const config = parseDaemonConfig({
      ...valid,
      setupCacheInputs: ["host.lock"],
      repositories: [
        {
          ...valid.repositories[0],
          setupCacheInputs: ["pnpm-lock.yaml"],
          worktrees: [
            {
              ...valid.repositories[0]!.worktrees[0],
              setupCacheInputs: ["Cargo.lock"],
            },
          ],
        },
      ],
    });
    expect(config.setupCacheInputs).toEqual(["host.lock"]);
    expect(config.repositories[0]?.setupCacheInputs).toEqual(["pnpm-lock.yaml"]);
    expect(config.repositories[0]?.worktrees[0]?.setupCacheInputs).toEqual(["Cargo.lock"]);
    expect(
      parseDaemonConfig({
        ...valid,
        setupCacheInputs: [],
      }),
    ).not.toHaveProperty("setupCacheInputs");
  });

  it("parses operator-declared host-absolute setup cache inputs", () => {
    const config = parseDaemonConfig({
      ...valid,
      setupCacheHostInputs: ["/opt/auto-harness/setup/host-environment"],
    });
    expect(config.setupCacheHostInputs).toEqual(["/opt/auto-harness/setup/host-environment"]);
    expect(
      parseDaemonConfig({
        ...valid,
        setupCacheHostInputs: [],
      }),
    ).not.toHaveProperty("setupCacheHostInputs");
  });

  it("rejects foreign Windows host-input paths on non-Windows hosts", () => {
    if (process.platform === "win32") {
      expect(
        parseDaemonConfig({
          ...valid,
          setupCacheHostInputs: [
            "C:\\auto-harness\\setup\\env",
            "\\\\host\\share\\env",
            "//host/share/env",
          ],
        }).setupCacheHostInputs,
      ).toEqual(["C:\\auto-harness\\setup\\env", "\\\\host\\share\\env", "//host/share/env"]);
      return;
    }
    for (const setupCacheHostInputs of [
      ["C:\\auto-harness\\setup\\env"],
      ["\\\\host\\share\\env"],
      ["//host/share/env"],
      ["/opt/auto-harness/setup/host-environment", "C:\\auto-harness\\setup\\env"],
    ]) {
      expect(() =>
        parseDaemonConfig({
          ...valid,
          setupCacheHostInputs,
        }),
      ).toThrow(/setupCacheHostInputs is not valid/);
    }
  });
});
