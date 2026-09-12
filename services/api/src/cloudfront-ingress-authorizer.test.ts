import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFRONT_INGRESS_TOKEN_HEADER,
  createCloudFrontIngressAuthorizer,
} from "./cloudfront-ingress-authorizer.ts";

describe("CloudFront ingress authorizer", () => {
  it("fails closed and accepts only the CloudFront origin credential", async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: "origin-token" });
    const authorize = createCloudFrontIngressAuthorizer({
      client: { send },
      secretArn: "secret-arn",
    });

    await expect(
      authorize({ headers: { [CLOUDFRONT_INGRESS_TOKEN_HEADER]: "forged" } }),
    ).resolves.toEqual({
      isAuthorized: false,
    });
    await expect(
      authorize({ headers: { "X-Auto-Harness-Ingress-Token": "origin-token" } }),
    ).resolves.toEqual({ isAuthorized: true });
    await expect(authorize({})).resolves.toEqual({ isAuthorized: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(GetSecretValueCommand));
  });

  it("denies a missing configuration or unreadable secret without leaking an exception", async () => {
    const missing = createCloudFrontIngressAuthorizer();
    const send = vi.fn().mockRejectedValue(new Error("denied"));
    const unavailable = createCloudFrontIngressAuthorizer({
      client: { send },
      secretArn: "secret-arn",
    });

    await expect(
      missing({ headers: { [CLOUDFRONT_INGRESS_TOKEN_HEADER]: "origin-token" } }),
    ).resolves.toEqual({ isAuthorized: false });
    await expect(
      unavailable({ headers: { [CLOUDFRONT_INGRESS_TOKEN_HEADER]: "origin-token" } }),
    ).resolves.toEqual({ isAuthorized: false });
    await expect(
      unavailable({ headers: { [CLOUDFRONT_INGRESS_TOKEN_HEADER]: "origin-token" } }),
    ).resolves.toEqual({ isAuthorized: false });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
