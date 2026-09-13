import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GITHUB_DELIVERY_ID_PATTERN, isGitHubDeliveryId } from "./github-delivery-id.ts";

const githubUuid = "123e4567-e89b-12d3-a456-426614174000";

describe("GitHub delivery IDs", () => {
  it.each([githubUuid, "delivery-1", "A", `${"x".repeat(128)}`, "abc_def:1.2"])(
    "accepts %s",
    (value) => {
      expect(isGitHubDeliveryId(value)).toBe(true);
    },
  );

  it.each(["", "x".repeat(129), "delivery id", "id@", "id/1", "id+1"])("rejects %s", (value) => {
    expect(isGitHubDeliveryId(value)).toBe(false);
  });

  it("publishes the same pattern in OpenAPI", () => {
    const openapi = readFileSync(new URL("../../../docs/openapi.yaml", import.meta.url), "utf8");
    expect(GITHUB_DELIVERY_ID_PATTERN).toBe("^[A-Za-z0-9._:-]{1,128}$");
    expect(openapi).toContain(`pattern: "${GITHUB_DELIVERY_ID_PATTERN}"`);
  });
});
