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
        "HARNESS_CHILD_ENV_ALLOWLIST has an empty entry at position 2",
        "HARNESS_CHILD_ENV_ALLOWLIST invalid name at position 3",
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

  it("does not treat inherited object properties as defined environment variables", () => {
    expect(
      parseChildEnvAllowlist({
        HARNESS_CHILD_ENV_ALLOWLIST: "constructor,toString,__proto__",
      }),
    ).toEqual({
      keys: [],
      errors: [
        "HARNESS_CHILD_ENV_ALLOWLIST undefined name: constructor",
        "HARNESS_CHILD_ENV_ALLOWLIST undefined name: toString",
        "HARNESS_CHILD_ENV_ALLOWLIST undefined name: __proto__",
      ],
    });
  });

  it("keeps a baseline var under Windows' native casing (Path, not PATH)", () => {
    // NodeJS.ProcessEnv keys are compared case-sensitively; Windows commonly
    // reports "Path"/"Temp" rather than the POSIX-conventional uppercase
    // spelling. Case-insensitive matching must still recognize it as
    // baseline, and the original casing must be preserved on the way out.
    expect(createChildEnv({ Path: "C:\\bin", SECRET: "nope" }, "win32")).toEqual({
      Path: "C:\\bin",
    });
  });

  it("does not case-fold baseline keys on POSIX", () => {
    // Case-insensitive matching is a Windows-only accommodation. Folding it
    // on POSIX would widen the allowlist to variables that only happen to
    // share a baseline name's letters in a different case, which is never
    // the intent of a fixed, documented allowlist.
    expect(createChildEnv({ Path: "not-real-path", SECRET: "nope" }, "linux")).toEqual({});
  });

  it("does not echo a malformed entry that may contain a secret", () => {
    const result = parseChildEnvAllowlist({
      HARNESS_CHILD_ENV_ALLOWLIST: "TOKEN=super-secret",
    });
    expect(result.errors).toEqual(["HARNESS_CHILD_ENV_ALLOWLIST invalid name at position 1"]);
    expect(result.errors.join(" ")).not.toContain("super-secret");
  });
});
