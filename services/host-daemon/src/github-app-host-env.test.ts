import { describe, expect, it } from "vitest";

import { persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";

describe("GitHub App host environment", () => {
  it("rejects a relative App configuration path without replacing an existing service file", () => {
    const original =
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\n";
    expect(
      preparePersistedEnv({
        existing: original,
        example: "",
        env: { HARNESS_GITHUB_APP_CONFIG: "github-app.json" },
      }),
    ).toEqual({ contents: original, errors: ["HARNESS_GITHUB_APP_CONFIG"] });
    expect(persistedEnvError(["HARNESS_GITHUB_APP_CONFIG"])).toContain("absolute path");
  });
});
