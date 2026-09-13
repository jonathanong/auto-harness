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
});
