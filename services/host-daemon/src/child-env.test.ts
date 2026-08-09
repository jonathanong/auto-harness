import { describe, expect, it } from "vitest";

import { createChildEnv } from "./child-env.ts";

describe("child environment", () => {
  it("rejects case-insensitive HARNESS_ names from the allowlist", () => {
    expect(
      createChildEnv({
        HARNESS_API_KEY: "secret",
        HARNESS_CHILD_ENV_ALLOWLIST: "harness_api_key,HaRnEsS_TOKEN,SAFE",
        HARNESS_TOKEN: "also-secret",
        SAFE: "allowed",
      }),
    ).toEqual({ SAFE: "allowed" });
  });
});
