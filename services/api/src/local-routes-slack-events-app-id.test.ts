import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type SlackIntegrationRecord,
} from "./slack-integration-types.ts";
import {
  signSlackBody,
  slackTestCredentials,
  slackTestNow,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

function oauthPlane(appId?: string): ControlPlane {
  const plane = new ControlPlane({ now: () => slackTestNow });
  plane.state.slackIntegration = {
    id: "slack",
    type: "slack",
    encryptedConfig: "not-used-for-oauth-events",
    defaultChannel: "#harness",
    enabled: true,
    notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
    signingSecretConfigured: false,
    installationMethod: "oauth",
    workspaceId: "T1",
    ...(appId ? { appId } : {}),
    grantedScopes: ["chat:write", "app_mentions:read", "im:history"],
    version: 1,
    createdAt: slackTestNow,
    updatedAt: slackTestNow,
  } satisfies SlackIntegrationRecord;
  return plane;
}

function event(apiAppId?: string) {
  return {
    type: "event_callback",
    team_id: "T1",
    ...(apiAppId === undefined ? {} : { api_app_id: apiAppId }),
    event_id: `Ev${apiAppId ?? "missing"}`,
    event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
  };
}

describe("OAuth Slack event app identity", () => {
  it("requires a matching app ID for OAuth rows that retained app metadata", async () => {
    const plane = oauthPlane("A1");
    const handler = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
      rateLimitConfig: { enabled: false },
    }).handler;
    const wrong = event("A2");
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/integrations/slack/events",
        wrong,
        signSlackBody(wrong),
      ),
    ).toMatchObject({ status: 401, json: { error: { message: "invalid Slack app" } } });
    const missing = event();
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/integrations/slack/events",
        missing,
        signSlackBody(missing),
      ),
    ).toMatchObject({ status: 401, json: { error: { message: "invalid Slack app" } } });
    expect(plane.state.slackInboundEvents.size).toBe(0);
  });

  it("accepts the matching app and permits legacy OAuth rows with no app metadata", async () => {
    const configured = oauthPlane("A1");
    const matching = event("A1");
    const handler = createLocalApp({
      plane: configured,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
      rateLimitConfig: { enabled: false },
    }).handler;
    expect(
      await invokeHandler(
        handler,
        "POST",
        "/api/v1/integrations/slack/events",
        matching,
        signSlackBody(matching),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(configured.state.slackInboundEvents.values().next().value).toMatchObject({
      apiAppId: "A1",
    });

    const legacy = oauthPlane(undefined);
    const legacyEvent = event("A2");
    expect(
      await invokeHandler(
        createLocalApp({
          plane: legacy,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
          rateLimitConfig: { enabled: false },
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        legacyEvent,
        signSlackBody(legacyEvent),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
  });
});
