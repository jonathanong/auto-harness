import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { valid } from "../test-helpers/config-test-helpers.ts";

describe("inventory config version", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "1", null])(
    "rejects an invalid present value %j",
    (version) => {
      expect(() => parseDaemonConfig({ ...valid, version })).toThrow(
        "version must be a non-negative safe integer",
      );
    },
  );

  it("leaves an absent version optional", () => {
    expect(parseDaemonConfig(valid)).not.toHaveProperty("inventoryVersion");
  });
});
