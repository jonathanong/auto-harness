import { describe, expect, it } from "vitest";

import { deployedSlackPublicBaseUrl } from "./slack-oauth.ts";

describe("Slack OAuth deployment URL", () => {
  it("accepts only a root HTTPS deployment URL", () => {
    expect(deployedSlackPublicBaseUrl("https://d1234.cloudfront.net")).toBe(
      "https://d1234.cloudfront.net/",
    );
    for (const value of [
      undefined,
      "http://localhost:7421",
      "https://user:password@harness.example",
      "https://harness.example/control-plane",
      "https://harness.example/?debug=1",
      "not a URL",
    ]) {
      expect(deployedSlackPublicBaseUrl(value)).toBeUndefined();
    }
  });
});
