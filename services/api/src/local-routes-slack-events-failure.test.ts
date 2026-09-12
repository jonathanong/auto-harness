import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import {
  invokeSlackRaw,
  signSlackBody,
  signSlackRaw,
  slackTestCredentials,
  slackTestEncryptor,
  slackTestNow,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

describe("Slack event route failures", () => {
  it("uses a manual installation secret and ignores unsupported events without storing them", async () => {
    const plane = new ControlPlane({
      secretEncryptor: slackTestEncryptor,
      now: () => slackTestNow,
    });
    plane.state.slackOAuthClient = {
      authTestBotToken: async () => ({ workspaceId: "T1", appId: "A1", botUserId: "Ubot" }),
    } as never;
    expect(
      (
        await plane.createSlackIntegrationDurable({
          botToken: "xoxb-1234567890-abcdefghij",
          signingSecret: "manual-signing-secret",
          defaultChannel: "#harness",
        })
      ).ok,
    ).toBe(true);
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    const ignored = {
      type: "event_callback",
      team_id: "T1",
      event_id: "ignored",
      event: { type: "message", channel_type: "channel" },
    };
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        ignored,
        signSlackRaw(JSON.stringify(ignored), "manual-signing-secret"),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    const accepted = {
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      authorizations: [{ user_id: "Ubot" }],
      event_id: "accepted",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
    };
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        accepted,
        signSlackRaw(JSON.stringify(accepted), "manual-signing-secret"),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        accepted,
        signSlackRaw(JSON.stringify(accepted), "manual-signing-secret"),
      ),
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(plane.state.slackInboundEvents.size).toBe(1);
  });

  it("returns route errors for malformed and oversized signed bodies", async () => {
    const plane = new ControlPlane({ now: () => slackTestNow });
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    const malformed = await invokeSlackRaw(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/events",
      "{bad",
      signSlackRaw("{bad", slackTestCredentials.signingSecret),
    );
    expect(malformed).toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR" } },
    });
    const oversized = await invokeSlackRaw(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/events",
      "x".repeat(256 * 1024 + 1),
    );
    expect(oversized).toMatchObject({
      status: 413,
      json: { error: { code: "PAYLOAD_TOO_LARGE" } },
    });
  });

  it("fails closed when durable lookup, storage, or audit boundaries fail", async () => {
    const lookupFailure = new ControlPlane({ now: () => slackTestNow });
    lookupFailure.state.storage = {
      getSlackIntegration: async () => {
        throw new Error("lookup");
      },
    } as never;
    const lookupApp = createLocalApp({
      plane: lookupFailure,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    expect(
      await invokeHandler(
        lookupApp.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        {},
        signSlackBody({}),
      ),
    ).toMatchObject({ status: 500 });

    const storageFailure = new ControlPlane({
      secretEncryptor: slackTestEncryptor,
      now: () => slackTestNow,
    });
    storageFailure.state.slackOAuthClient = {
      authTestBotToken: async () => ({ workspaceId: "T1", appId: "A1", botUserId: "Ubot" }),
    } as never;
    await storageFailure.createSlackIntegrationDurable({
      botToken: "xoxb-1234567890-abcdefghij",
      signingSecret: "manual-signing-secret",
      defaultChannel: "#harness",
    });
    const record = storageFailure.state.slackIntegration!;
    storageFailure.state.storage = {
      getSlackIntegration: async () => record,
      putSlackInboundEvent: async () => {
        throw new Error("write");
      },
      putAuditLog: async () => undefined,
    } as never;
    const storageApp = createLocalApp({
      plane: storageFailure,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    const event = {
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      authorizations: [{ user_id: "Ubot" }],
      event_id: "storage-failure",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
    };
    expect(
      await invokeHandler(
        storageApp.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        event,
        signSlackRaw(JSON.stringify(event), "manual-signing-secret"),
      ),
    ).toMatchObject({ status: 500 });

    const auditFailure = new ControlPlane({ now: () => slackTestNow });
    auditFailure.appendAuditLog = async () => {
      throw new Error("audit");
    };
    const auditApp = createLocalApp({
      plane: auditFailure,
      authMode: "disabled",
      slackAppCredentials: slackTestCredentials,
    });
    expect(
      await invokeHandler(
        auditApp.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        {},
        { "x-slack-request-timestamp": "1", "x-slack-signature": `v0=${"0".repeat(64)}` },
      ),
    ).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
    expect(auditFailure.state.auditLogs.size).toBe(0);
  });
});
