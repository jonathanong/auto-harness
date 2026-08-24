import { describe, expect, it } from "vitest";

import { persistedEnvError, validatePersistedEnvFile } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";

describe("persisted execution profiles", () => {
  it("rejects relative paths before they reach a service environment", () => {
    const original =
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\n";
    expect(
      validatePersistedEnvFile(`${original}HARNESS_EXECUTION_PROFILES=profiles.json\n`),
    ).toEqual(["HARNESS_EXECUTION_PROFILES"]);
    expect(
      validatePersistedEnvFile(
        `${original}HARNESS_EXECUTION_PROFILES=C:\\auto-harness\\profiles.json\n`,
      ),
    ).toEqual([]);

    expect(
      preparePersistedEnv({
        existing: original,
        example: "",
        env: { HARNESS_EXECUTION_PROFILES: "profiles.json" },
      }),
    ).toEqual({ contents: original, errors: ["HARNESS_EXECUTION_PROFILES"] });
    expect(
      preparePersistedEnv({
        existing: undefined,
        example: original,
        env: {
          HARNESS_HOST_ID: "host-1",
          HARNESS_API_URL: "https://control.example.com",
          HARNESS_API_KEY: "secret",
          HARNESS_EXECUTION_PROFILES: "profiles.json",
        },
      }),
    ).toEqual({ contents: "", errors: ["HARNESS_EXECUTION_PROFILES"] });
    expect(persistedEnvError(["HARNESS_EXECUTION_PROFILES"])).toContain("absolute path");
  });
});
