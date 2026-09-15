import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { createLambdaRuntime } from "./lambda-handlers.ts";

// The real cold-start path (no injected `created`) constructs a live control plane via
// createControlPlane, which would otherwise need real AWS/DynamoDB access. Mock just that
// boundary so the cold-start test below still exercises lambda-handlers.ts's own SSM/Slack
// wiring for real.
vi.mock("./create-plane.ts", () => ({ createControlPlane: vi.fn() }));

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

describe("Lambda runtime real cold start (no injected `created`)", () => {
  it("bootstraps from SSM, loads Slack app config from env, and memoizes the OAuth origin", async () => {
    const plane = new ControlPlane({
      secretEncryptor: { decrypt: async (value) => value, encrypt: async (value) => value },
    });
    const storage = { settleStorage: vi.fn(async () => undefined) };
    vi.mocked(createControlPlane).mockResolvedValue({ plane, storage } as never);
    const auth = new AuthService({
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
      mode: "required",
      secret: "a".repeat(32),
    });

    const previousEnv = {
      admins: process.env.HARNESS_ADMINS_SSM_PARAM,
      session: process.env.HARNESS_SESSION_SECRET_SSM_PARAM,
      cursor: process.env.HARNESS_CURSOR_SECRET_SSM_PARAM,
      slackApp: process.env.HARNESS_SLACK_APP,
      publicBaseUrlParam: process.env.PUBLIC_BASE_URL_SSM_PARAM,
    };
    let publicBaseUrlRequests = 0;
    const send = vi.fn(async (command: { input: { Name: string } }) => {
      if (command.input.Name === process.env.PUBLIC_BASE_URL_SSM_PARAM) {
        publicBaseUrlRequests += 1;
        return publicBaseUrlRequests === 1
          ? { Parameter: {} }
          : { Parameter: { Value: "https://after-cold-start.example" } };
      }
      return { Parameter: { Value: "s".repeat(32) } };
    });

    try {
      process.env.HARNESS_ADMINS_SSM_PARAM = "/auto-harness/admins";
      process.env.HARNESS_SESSION_SECRET_SSM_PARAM = "/auto-harness/session-secret";
      process.env.HARNESS_CURSOR_SECRET_SSM_PARAM = "/auto-harness/cursor-secret";
      process.env.HARNESS_SLACK_APP = JSON.stringify({
        clientId: "cold-start-client",
        clientSecret: "cold-start-secret",
        signingSecret: "cold-start-signing-secret",
      });
      delete process.env.PUBLIC_BASE_URL_SSM_PARAM;

      const runtime = await createLambdaRuntime({
        auth,
        ssmClient: { send } as never,
        management: { send: vi.fn(async () => ({})) },
        slackOAuthClient: { exchangeCode: vi.fn(), revokeBotToken: vi.fn() } as never,
      });

      process.env.PUBLIC_BASE_URL_SSM_PARAM = "/auto-harness/public-base-url";
      const startOAuth = () =>
        runtime.rest({
          body: JSON.stringify({ defaultChannel: "#harness" }),
          headers: { authorization: `Basic ${Buffer.from("root:root").toString("base64")}` },
          rawPath: "/api/v1/integrations/slack/oauth/start",
          requestContext: { http: { method: "POST" } },
        });

      // SSM has no value yet: resolveSlackOAuthPublicBaseUrl's refetch comes up empty.
      await expect(startOAuth()).resolves.toMatchObject({ statusCode: 503 });

      // SSM now has a value: the refetch succeeds and memoizes it.
      await expect(startOAuth()).resolves.toMatchObject({ statusCode: 201 });

      // A third call reuses the memoized origin without another SSM lookup.
      const callsBeforeThirdRequest = send.mock.calls.length;
      await expect(startOAuth()).resolves.toMatchObject({ statusCode: 201 });
      expect(send.mock.calls.length).toBe(callsBeforeThirdRequest);
    } finally {
      if (previousEnv.admins === undefined) delete process.env.HARNESS_ADMINS_SSM_PARAM;
      else process.env.HARNESS_ADMINS_SSM_PARAM = previousEnv.admins;
      if (previousEnv.session === undefined) delete process.env.HARNESS_SESSION_SECRET_SSM_PARAM;
      else process.env.HARNESS_SESSION_SECRET_SSM_PARAM = previousEnv.session;
      if (previousEnv.cursor === undefined) delete process.env.HARNESS_CURSOR_SECRET_SSM_PARAM;
      else process.env.HARNESS_CURSOR_SECRET_SSM_PARAM = previousEnv.cursor;
      if (previousEnv.slackApp === undefined) delete process.env.HARNESS_SLACK_APP;
      else process.env.HARNESS_SLACK_APP = previousEnv.slackApp;
      if (previousEnv.publicBaseUrlParam === undefined)
        delete process.env.PUBLIC_BASE_URL_SSM_PARAM;
      else process.env.PUBLIC_BASE_URL_SSM_PARAM = previousEnv.publicBaseUrlParam;
    }
  });
});
