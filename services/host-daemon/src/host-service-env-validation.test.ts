/* eslint-disable max-lines -- persisted identity and updater reset cases share one fixture. */
import { describe, expect, it } from "vitest";

import { persistedEnvError, validatePersistedEnvFile } from "./host-service-env.ts";
import {
  preparePersistedEnv,
  serviceEnv,
  updatePersistedApiUrl,
} from "./host-service-env-persisted.ts";

describe("persisted service environment validation", () => {
  it("defaults missing persisted keys and preserves or overrides process environment", () => {
    expect(validatePersistedEnvFile("")).toEqual([
      "HARNESS_HOST_ID",
      "HARNESS_API_URL",
      "HARNESS_API_KEY",
    ]);
    const env = { HARNESS_API_URL: "https://old.example.com" };
    expect(serviceEnv(env, undefined)).toBe(env);
    expect(serviceEnv(env, "https://new.example.com")).toMatchObject({
      HARNESS_API_URL: "https://new.example.com",
    });
  });

  it("accepts production identity and rejects local or placeholder values", () => {
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual([]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=local-1\nHARNESS_API_URL=https://localhost\nHARNESS_API_KEY=REPLACE_WITH_KEY\n",
      ),
    ).toEqual(["HARNESS_HOST_ID", "HARNESS_API_URL", "HARNESS_API_KEY"]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=http://control.example.com\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual(["HARNESS_API_URL"]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_HTTP=https://control.example.com\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual(["HARNESS_API_URL"]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-your-team\nHARNESS_API_URL=https://your-company.com\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual([]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://127.0.0.2\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual(["HARNESS_API_URL"]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com/api\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual(["HARNESS_API_URL"]);
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://id.execute-api.us-east-1.amazonaws.com.\nHARNESS_API_KEY=secret\n",
      ),
    ).toEqual(["HARNESS_API_URL"]);
  });

  it("validates the persisted host assignment cap before service installation", () => {
    const identity =
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\n";
    for (const value of ["1", "64", "256", ""]) {
      expect(
        validatePersistedEnvFile(`${identity}HARNESS_MAX_CONCURRENT_ASSIGNMENTS=${value}\n`),
      ).toEqual([]);
    }
    for (const value of ["0", "257", "nope", "2.5"]) {
      expect(
        validatePersistedEnvFile(`${identity}HARNESS_MAX_CONCURRENT_ASSIGNMENTS=${value}\n`),
      ).toEqual(["HARNESS_MAX_CONCURRENT_ASSIGNMENTS"]);
    }
  });

  it("reports only variable names and remediation, never persisted values", () => {
    const message = persistedEnvError(["HARNESS_API_URL", "HARNESS_API_KEY"]);
    expect(message).toContain("HARNESS_API_URL");
    expect(message).toContain("HARNESS_API_KEY");
    expect(message).toContain("HTTPS");
    expect(message).not.toContain("secret");
  });

  it("rejects invalid or missing persisted child environment names without exposing values", () => {
    const errors = validatePersistedEnvFile(
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\nHARNESS_CHILD_ENV_ALLOWLIST=TOKEN,HARNESS_API_KEY,not-valid!,TOKEN\nTOKEN=blackboard-secret\n",
    );
    expect(errors).toEqual([
      "HARNESS_CHILD_ENV_ALLOWLIST reserved name: HARNESS_API_KEY",
      "HARNESS_CHILD_ENV_ALLOWLIST invalid name at position 3",
      "HARNESS_CHILD_ENV_ALLOWLIST duplicate name: TOKEN",
    ]);
    expect(errors.join(" ")).not.toContain("blackboard-secret");
    expect(
      validatePersistedEnvFile(
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\nHARNESS_CHILD_ENV_ALLOWLIST=MISSING\n",
      ),
    ).toEqual(["HARNESS_CHILD_ENV_ALLOWLIST undefined name: MISSING"]);
    expect(
      preparePersistedEnv({
        existing: undefined,
        example:
          "HARNESS_HOST_ID=\nHARNESS_API_URL=\nHARNESS_API_KEY=\nHARNESS_CHILD_ENV_ALLOWLIST=\n",
        env: {
          HARNESS_HOST_ID: "host-1",
          HARNESS_API_URL: "https://control.example.com",
          HARNESS_API_KEY: "secret",
          HARNESS_CHILD_ENV_ALLOWLIST: "MISSING",
        },
      }),
    ).toEqual({
      contents: "",
      errors: ["HARNESS_CHILD_ENV_ALLOWLIST undefined name: MISSING"],
    });
  });

  it("updates only the persisted API URL and retains the bound key", () => {
    const original =
      "# keep this\nHARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://old.example.com\nHARNESS_API_KEY=secret\nOTHER=value\n";
    const updated = updatePersistedApiUrl(original, "https://new.example.com");
    expect(updated).toContain("# keep this");
    expect(updated).toContain("HARNESS_HOST_ID=host-1");
    expect(updated).toContain("HARNESS_API_URL=https://new.example.com");
    expect(updated).toContain("HARNESS_API_KEY=secret");
    expect(updated).toContain("OTHER=value");
    expect(updatePersistedApiUrl("HARNESS_HOST_ID=host-1\n", "https://new.example.com")).toContain(
      "HARNESS_API_URL=https://new.example.com",
    );
  });

  it("merges exported execution settings without replacing unrelated persisted values", () => {
    const original =
      "# keep this\nHARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\nOTHER=value\n";
    const updated = preparePersistedEnv({
      existing: original,
      example: "",
      env: {
        HARNESS_EXECUTION_PROFILES: "/etc/auto-harness/profiles.json",
        HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "3",
      },
    }).contents;
    expect(updated).toContain("# keep this");
    expect(updated).toContain("HARNESS_API_KEY=secret");
    expect(updated).toContain("OTHER=value");
    expect(updated).toContain("HARNESS_EXECUTION_PROFILES=/etc/auto-harness/profiles.json");
    expect(updated).toContain("HARNESS_MAX_CONCURRENT_ASSIGNMENTS=3");
    expect(
      preparePersistedEnv({
        existing: `${original}HARNESS_EXECUTION_PROFILES=/old/profiles.json\n`,
        example: "",
        env: { HARNESS_EXECUTION_PROFILES: "/new/profiles.json" },
      }).contents,
    ).toContain("HARNESS_EXECUTION_PROFILES=/new/profiles.json");
    expect(preparePersistedEnv({ existing: original, example: "", env: {} }).contents).toBe(
      original,
    );
  });

  it("escapes a persisted updater PEM for an EnvironmentFile", () => {
    const original =
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\n";
    const updated = preparePersistedEnv({
      existing: original,
      example: "",
      env: { HARNESS_UPDATE_PUBLIC_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----" },
    }).contents;
    expect(updated).toContain(
      'HARNESS_UPDATE_PUBLIC_KEY="-----BEGIN KEY-----\\\\nabc\\\\n-----END KEY-----"',
    );
  });

  it("clears persisted updater settings when explicitly set to blank", () => {
    const original =
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\nHARNESS_UPDATE_MANIFEST_URL=https://updates.example.test/manifest.json\nHARNESS_UPDATE_PUBLIC_KEY=old-key\nHARNESS_UPDATE_INSTALL_DIR=/srv/updates\nHARNESS_UPDATE_POLL_MS=60000\nHARNESS_DAEMON_VERSION=1.2.3\n";
    const updated = preparePersistedEnv({
      existing: original,
      example: "",
      env: {
        HARNESS_UPDATE_MANIFEST_URL: "",
        HARNESS_UPDATE_PUBLIC_KEY: "",
        HARNESS_UPDATE_INSTALL_DIR: "",
        HARNESS_UPDATE_POLL_MS: "",
        HARNESS_DAEMON_VERSION: "",
      },
    }).contents;
    expect(updated).toContain("HARNESS_UPDATE_MANIFEST_URL=\n");
    expect(updated).toContain("HARNESS_UPDATE_PUBLIC_KEY=\n");
    expect(updated).toContain("HARNESS_UPDATE_INSTALL_DIR=\n");
    expect(updated).toContain("HARNESS_UPDATE_POLL_MS=\n");
    expect(updated).toContain("HARNESS_DAEMON_VERSION=\n");
    expect(updated).not.toContain("old-key");
    expect(updated).not.toContain("updates.example.test");
  });

  it("rejects multiline URL replacements before editing persisted contents", () => {
    const original =
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://old.example.com\nHARNESS_API_KEY=secret\n";
    const prepared = preparePersistedEnv({
      existing: original,
      example: "",
      env: {},
      apiUrl: "https://new.example.com\nHARNESS_HOST_ID=other-host",
    });
    expect(prepared.errors).toEqual(["HARNESS_API_URL"]);
    expect(prepared.contents).toBe(original);
    expect(
      preparePersistedEnv({ existing: undefined, example: "", env: {}, apiUrl: "http://public" }),
    ).toEqual({ contents: "", errors: ["HARNESS_API_URL"] });
  });

  it("rejects URL credentials, queries, and fragments", () => {
    for (const apiUrl of [
      "https://user:secret@control.example.com",
      "https://control.example.com?region=x",
      "https://control.example.com#fragment",
    ]) {
      expect(
        validatePersistedEnvFile(
          `HARNESS_HOST_ID=host-1\nHARNESS_API_URL=${apiUrl}\nHARNESS_API_KEY=secret\n`,
        ),
      ).toEqual(["HARNESS_API_URL"]);
    }
  });
});
