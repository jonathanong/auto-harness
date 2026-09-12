import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type SlackIntegrationRecord,
} from "./slack-integration-types.ts";
import {
  invokeSlackRaw,
  signSlackRaw,
  signSlackBody,
  slackTestCredentials,
  slackTestNow,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const event = {
  type: "event_callback",
  team_id: "T1",
  event_id: "Ev1",
  event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
};

function oauthPlane(): ControlPlane {
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
    appId: "A1",
    grantedScopes: ["chat:write", "app_mentions:read", "im:history"],
    version: 1,
    createdAt: slackTestNow,
    updatedAt: slackTestNow,
  } satisfies SlackIntegrationRecord;
  return plane;
}

describe("Slack event route validation", () => {
  it("fails closed without OAuth app credentials and fences the installed workspace", async () => {
    const plane = oauthPlane();
    const withoutCredentials = createLocalApp({ plane, authMode: "disabled" });
    expect(
      await invokeHandler(
        withoutCredentials.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        event,
        signSlackBody(event),
      ),
    ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });

    const wrongWorkspace = { ...event, team_id: "T2", event_id: "Ev2" };
    const configured = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    expect(
      await invokeHandler(
        configured.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        wrongWorkspace,
        signSlackBody(wrongWorkspace),
      ),
    ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
  });

  it("does not durably audit invalid input and preserves the ACK after audit failure", async () => {
    const unsigned = createLocalApp({
      plane: new ControlPlane({ now: () => slackTestNow }),
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    expect(
      await invokeHandler(unsigned.handler, "POST", "/api/v1/integrations/slack/events", event),
    ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
    expect((await unsigned.plane.listAuditLogs()).items).toEqual([]);

    const malformed = createLocalApp({
      plane: new ControlPlane({ now: () => slackTestNow }),
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    expect(
      await invokeSlackRaw(
        malformed.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        "{bad",
        signSlackRaw("{bad", slackTestCredentials.signingSecret),
      ),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect((await malformed.plane.listAuditLogs()).items).toEqual([]);

    const plane = oauthPlane();
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const acceptedEvent = { ...event, api_app_id: "A1" };
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        acceptedEvent,
        signSlackBody(acceptedEvent),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(plane.state.slackInboundEvents.size).toBe(1);
  });
});
