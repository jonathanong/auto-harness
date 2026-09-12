import { timingSafeEqual } from "node:crypto";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";

export const CLOUDFRONT_INGRESS_TOKEN_HEADER = "x-auto-harness-ingress-token";

type SecretsManagerClientLike = {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
};

export type CloudFrontIngressAuthorizerEvent = {
  headers?: Record<string, string | undefined>;
};

export type CloudFrontIngressAuthorizerResponse = { isAuthorized: boolean };

export function createCloudFrontIngressAuthorizer(
  input: {
    client?: SecretsManagerClientLike;
    secretArn?: string | undefined;
  } = {},
): (event: CloudFrontIngressAuthorizerEvent) => Promise<CloudFrontIngressAuthorizerResponse> {
  const client = input.client ?? new SecretsManagerClient({});
  const secretArn = input.secretArn;
  let expectedToken: Promise<string | undefined> | undefined;

  return async (event) => {
    const token = header(event.headers, CLOUDFRONT_INGRESS_TOKEN_HEADER);
    if (!token || !secretArn) return { isAuthorized: false };
    expectedToken ??= client.send(new GetSecretValueCommand({ SecretId: secretArn })).then(
      ({ SecretString }) => SecretString,
      () => {
        // Fail this request closed, but retry a later request: a transient
        // Secrets Manager or IAM failure must not poison a warm container.
        expectedToken = undefined;
        return undefined;
      },
    );
    const expected = await expectedToken;
    return { isAuthorized: tokensMatch(token, expected) };
  };
}

function header(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function tokensMatch(value: string, expected: string | undefined): boolean {
  if (!expected || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export const ingressAuthorizer = createCloudFrontIngressAuthorizer({
  secretArn: process.env.HARNESS_CLOUDFRONT_INGRESS_SECRET_ARN,
});
