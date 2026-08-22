import { describe, expect, it } from "vitest";

import { createChildEnv, parseChildEnvAllowlist } from "./child-env.ts";

describe("child environment", () => {
  it("rejects malformed, reserved, duplicate, and undefined names", () => {
    const source = {
      HARNESS_CHILD_ENV_ALLOWLIST: "SAFE,,not-valid!,HaRnEsS_TOKEN,SAFE,MISSING",
      SAFE: "allowed",
    };
    expect(parseChildEnvAllowlist(source)).toEqual({
      keys: ["SAFE"],
      errors: [
        "HARNESS_CHILD_ENV_ALLOWLIST has an empty entry",
        "HARNESS_CHILD_ENV_ALLOWLIST invalid name: not-valid!",
        "HARNESS_CHILD_ENV_ALLOWLIST reserved name: HaRnEsS_TOKEN",
        "HARNESS_CHILD_ENV_ALLOWLIST duplicate name: SAFE",
        "HARNESS_CHILD_ENV_ALLOWLIST undefined name: MISSING",
      ],
    });
    expect(() => createChildEnv(source)).toThrow("reserved name: HaRnEsS_TOKEN");
  });

  it("accepts defined empty values", () => {
    expect(createChildEnv({ HARNESS_CHILD_ENV_ALLOWLIST: "EMPTY", EMPTY: "" })).toEqual({
      EMPTY: "",
    });
  });
});
