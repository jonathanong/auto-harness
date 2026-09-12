import { describe, expect, it } from "vitest";

import { parseSlackAppCredentials } from "./slack-app-config.ts";

describe("Slack app credential configuration", () => {
  it("accepts opaque visible signing secrets", () => {
    expect(
      parseSlackAppCredentials(
        JSON.stringify({
          clientId: "client",
          clientSecret: "client-secret",
          signingSecret: "slack-signing_secret-123",
        }),
      ),
    ).toEqual({
      clientId: "client",
      clientSecret: "client-secret",
      signingSecret: "slack-signing_secret-123",
    });
  });

  it("fails closed for absent, malformed, incomplete, and invalid secret configuration", () => {
    for (const value of [
      undefined,
      "{",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ clientId: "", clientSecret: "secret", signingSecret: "a".repeat(16) }),
      JSON.stringify({ clientId: "id", clientSecret: "", signingSecret: "a".repeat(16) }),
      JSON.stringify({ clientId: "id", clientSecret: "secret", signingSecret: "too-short" }),
      JSON.stringify({
        clientId: "id",
        clientSecret: "secret",
        signingSecret: "a".repeat(16) + "\n",
      }),
    ]) {
      expect(parseSlackAppCredentials(value)).toBeUndefined();
    }
  });
});
