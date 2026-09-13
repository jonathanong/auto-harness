import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLambdaRuntime } from "./lambda-handlers.ts";

function runtimeWithInjectedSlackDependencies() {
  const storage = {
    settleStorage: vi.fn(async () => undefined),
  };
  const plane = new ControlPlane({
    publicBaseUrl: "https://harness.example",
    secretEncryptor: { decrypt: async (value) => value, encrypt: async (value) => value },
  });
  const auth = new AuthService({
    admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
      "base64url",
    ),
    mode: "required",
    secret: "a".repeat(32),
  });
  const slackOAuthClient = {
    exchangeCode: vi.fn(async () => ({
      appId: "A123",
      botToken: "xoxb-1234567890-abcdefghij",
      botUserId: "U123",
      scopes: ["chat:write", "app_mentions:read", "im:history"],
      workspaceId: "T123",
      workspaceName: "Harness",
    })),
    revokeBotToken: vi.fn(),
  };

  return {
    runtime: createLambdaRuntime({
      auth,
      created: { plane, storage } as never,
      management: { send: vi.fn(async () => ({})) },
      slackAppCredentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
        signingSecret: "slack-signing-secret",
      },
      slackOAuthClient,
    }),
    plane,
    slackOAuthClient,
  };
}

describe("Lambda runtime injected Slack dependencies", () => {
  it("starts and completes Slack OAuth with injected credentials and client", async () => {
    const fixture = runtimeWithInjectedSlackDependencies();

    const runtime = await fixture.runtime;
    const start = await runtime.rest({
      body: JSON.stringify({ defaultChannel: "#harness" }),
      headers: { authorization: `Basic ${Buffer.from("root:root").toString("base64")}` },
      rawPath: "/api/v1/integrations/slack/oauth/start",
      requestContext: { http: { method: "POST" } },
    });
    expect(start).toMatchObject({
      statusCode: 201,
      body: expect.stringContaining("https://slack.com/oauth/v2/authorize"),
    });
    const state = new URL(JSON.parse(start.body).url).searchParams.get("state");

    await expect(
      runtime.rest({
        rawPath: "/api/v1/integrations/slack/oauth/callback",
        rawQueryString: `state=${state}&code=code`,
        requestContext: { http: { method: "GET" } },
      }),
    ).resolves.toMatchObject({ statusCode: 302 });

    expect(fixture.slackOAuthClient.exchangeCode).toHaveBeenCalledOnce();
    expect(fixture.plane.state.slackIntegration).toMatchObject({ workspaceId: "T123" });
  });
});
