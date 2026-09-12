import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type SlackIntegrationRecord,
} from "./slack-integration-types.ts";
import {
  invokeSlackRaw,
  signSlackBody,
  signSlackRaw,
  slackTestCredentials,
  slackTestEncryptor,
  slackTestNow,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const event = {
  type: "event_callback",
  team_id: "T1",
  authorizations: [{ user_id: "Ubot" }],
  event_id: "Ev1",
  event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
};

async function manualPlane(): Promise<ControlPlane> {
  const plane = new ControlPlane({
    secretEncryptor: slackTestEncryptor,
    now: () => slackTestNow,
  });
  await plane.createSlackIntegrationDurable({
    botToken: "xoxb-1234567890-abcdefghij",
    signingSecret: "manual-signing-secret",
    defaultChannel: "#harness",
  });
  return plane;
}

function failAudits(plane: ControlPlane): void {
  plane.appendAuditLog = async () => {
    throw new Error("audit unavailable");
  };
}

function oauthPlane(): ControlPlane {
  const plane = new ControlPlane({ now: () => slackTestNow });
  plane.state.slackIntegration = {
    id: "slack",
    type: "slack",
    encryptedConfig: "unused",
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

describe("Slack event audit failures", () => {
  it("does not durably audit malformed events but preserves pre-commit audit failures", async () => {
    const invalid = new ControlPlane({ now: () => slackTestNow });
    failAudits(invalid);
    expect(
      await invokeSlackRaw(
        createLocalApp({
          plane: invalid,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        "{bad",
        signSlackRaw("{bad", slackTestCredentials.signingSecret),
      ),
    ).toMatchObject({ status: 400, json: { error: { code: "VALIDATION_ERROR" } } });
    expect(invalid.state.auditLogs.size).toBe(0);

    const uninstalled = new ControlPlane({ now: () => slackTestNow });
    failAudits(uninstalled);
    expect(
      await invokeHandler(
        createLocalApp({
          plane: uninstalled,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        event,
        signSlackBody(event),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });

    const mismatch = oauthPlane();
    failAudits(mismatch);
    const wrongWorkspace = { ...event, team_id: "T2", event_id: "Ev2" };
    expect(
      await invokeHandler(
        createLocalApp({
          plane: mismatch,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        wrongWorkspace,
        signSlackBody(wrongWorkspace),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });

    const appMismatch = oauthPlane();
    failAudits(appMismatch);
    const wrongApp = { ...event, api_app_id: "A2", event_id: "Ev-app-mismatch" };
    expect(
      await invokeHandler(
        createLocalApp({
          plane: appMismatch,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        wrongApp,
        signSlackBody(wrongApp),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
  });

  it("acknowledges unsupported signed events when their diagnostic audit fails", async () => {
    const plane = await manualPlane();
    let auditAttempts = 0;
    plane.appendAuditLog = async () => {
      auditAttempts += 1;
      throw new Error("audit unavailable");
    };
    const ignoredEvent = {
      ...event,
      event: { type: "message", channel_type: "channel" },
    };

    expect(
      await invokeHandler(
        createLocalApp({ plane, authMode: "disabled" }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        ignoredEvent,
        signSlackRaw(JSON.stringify(ignoredEvent), "manual-signing-secret"),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(auditAttempts).toBe(1);
    expect(plane.state.slackInboundEvents.size).toBe(0);
  });

  it("retains the audit failure response when inbound storage fails", async () => {
    const plane = oauthPlane();
    const integration = plane.state.slackIntegration!;
    let attemptedWrite = false;
    plane.state.storage = {
      getSlackIntegration: async () => integration,
      putSlackInboundEvent: async () => {
        attemptedWrite = true;
        throw new Error("storage unavailable");
      },
    } as never;
    failAudits(plane);

    expect(
      await invokeHandler(
        createLocalApp({
          plane,
          authMode: "disabled",
          slackAppCredentials: slackTestCredentials,
        }).handler,
        "POST",
        "/api/v1/integrations/slack/events",
        { ...event, api_app_id: "A1" },
        signSlackBody({ ...event, api_app_id: "A1" }),
      ),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    expect(attemptedWrite).toBe(true);
  });
});
