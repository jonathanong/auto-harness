import { describe, expect, it } from "vitest";

import { requestForLambdaEvent } from "./lambda-http-adapter.ts";

describe("Lambda HTTP adapter CloudFront viewer source", () => {
  it("uses a valid CloudFront-generated viewer address and ignores malformed values", () => {
    const event = {
      headers: {
        "CloudFront-Viewer-Address": "[2001:db8::7]:46532",
      },
      requestContext: { http: { sourceIp: "198.51.100.20" } },
    };
    expect(requestForLambdaEvent(event).socket.remoteAddress).toBe("2001:db8::7");
    expect(
      requestForLambdaEvent({
        ...event,
        headers: { "cloudfront-viewer-address": "203.0.113.8:53120" },
      }).socket.remoteAddress,
    ).toBe("203.0.113.8");
    expect(
      requestForLambdaEvent({
        ...event,
        headers: { "cloudfront-viewer-address": "[not-an-ip]:53120" },
      }).socket.remoteAddress,
    ).toBe("198.51.100.20");
    expect(
      requestForLambdaEvent({
        ...event,
        headers: { ...event.headers, "cloudfront-viewer-address": "not-an-ip" },
      }).socket.remoteAddress,
    ).toBe("198.51.100.20");
  });
});
