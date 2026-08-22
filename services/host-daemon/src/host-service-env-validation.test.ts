import { describe, expect, it } from "vitest";

import {
  persistedEnvError,
  updatePersistedApiUrl,
  validatePersistedEnvFile,
} from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";

describe("persisted service environment validation", () => {
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
  });

  it("reports only variable names and remediation, never persisted values", () => {
    const message = persistedEnvError(["HARNESS_API_URL", "HARNESS_API_KEY"]);
    expect(message).toContain("HARNESS_API_URL");
    expect(message).toContain("HARNESS_API_KEY");
    expect(message).toContain("HTTPS");
    expect(message).not.toContain("secret");
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
