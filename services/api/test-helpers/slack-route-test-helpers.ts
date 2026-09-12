import { createHmac } from "node:crypto";

import type { SecretEncryptor } from "../src/secret-crypto.ts";

export const slackTestNow = "2026-09-12T00:00:00.000Z";
export const slackTestCredentials = {
  clientId: "client",
  clientSecret: "secret",
  signingSecret: "a".repeat(32),
};
export const slackTestEncryptor: SecretEncryptor = {
  encrypt: async (value) => value,
  decrypt: async (value) => value,
};
export const slackTestOAuthClient = {
  authTestBotToken: async () => ({
    workspaceId: "T1",
    workspaceName: "Workspace",
    appId: "A1",
    botUserId: "Ubot",
  }),
};

export function signSlackBody(body: unknown): Record<string, string> {
  return signSlackRaw(JSON.stringify(body), slackTestCredentials.signingSecret);
}

export function signSlackRaw(raw: string, secret: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.parse(slackTestNow) / 1000));
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${raw}`)
      .digest("hex")}`,
  };
}

export async function invokeSlackRaw(
  handler: (req: never, res: never) => void | Promise<void>,
  method: string,
  path: string,
  raw: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  let status = 0;
  let payload = "";
  const req = {
    method,
    url: path,
    headers,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data") cb(Buffer.from(raw));
      if (event === "end") cb();
      return req;
    },
    destroy() {
      /* readRawBody uses this to stop an oversized request. */
    },
  };
  const res = {
    setHeader() {
      /* response metadata is not relevant to these route assertions. */
    },
    writeHead(code: number) {
      status = code;
    },
    end(value?: string) {
      payload = value ?? "";
    },
  };
  await handler(req as never, res as never);
  return { status, json: payload ? JSON.parse(payload) : null };
}
