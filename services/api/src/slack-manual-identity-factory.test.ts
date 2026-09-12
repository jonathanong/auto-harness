import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLambdaRuntime } from "./lambda-handlers.ts";
import { signSlackRaw } from "../test-helpers/slack-route-test-helpers.ts";

const botToken = "xoxb-1234567890-abcdefghij";
const signingSecret = "manual-signing-secret-123456";
const now = "2026-09-12T00:00:00.000Z";

function event(teamId: string, appId: string, eventId: string) {
  return {
    type: "event_callback",
    team_id: teamId,
    api_app_id: appId,
    authorizations: [{ user_id: "Ubot" }],
    event_id: eventId,
    event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("manual Slack identity production factory", () => {
  it("authenticates manual create and update without OAuth app credentials", async () => {
    vi.stubEnv("HARNESS_SLACK_APP", "");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        team_id: "T1",
        team: "Workspace",
        user_id: "Ubot",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const plane = new ControlPlane({
      now: () => now,
      secretEncryptor: { encrypt: async (value) => value, decrypt: async (value) => value },
    });
    await createLambdaRuntime({
      auth: new AuthService({ mode: "disabled" }),
      created: { plane, storage: undefined } as never,
      management: { send: async () => ({}) },
    });

    await expect(
      plane.createSlackIntegrationDurable({ botToken, signingSecret, defaultChannel: "#harness" }),
    ).resolves.toMatchObject({
      ok: true,
      integration: { workspaceId: "T1", botUserId: "Ubot", inboundAvailable: true },
    });
    await expect(
      plane.updateSlackIntegrationDurable({ botToken, signingSecret, defaultChannel: "#harness" }),
    ).resolves.toMatchObject({
      ok: true,
      integration: { workspaceId: "T1", botUserId: "Ubot", inboundAvailable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls).toEqual([
      [
        "https://slack.com/api/auth.test",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${botToken}` }),
        }),
      ],
      [
        "https://slack.com/api/auth.test",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${botToken}` }),
        }),
      ],
    ]);
  });

  it("fences manual inbound events to the identity returned by auth.test", async () => {
    vi.stubEnv("HARNESS_SLACK_APP", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, team_id: "T1", user_id: "Ubot" }),
      }),
    );
    const plane = new ControlPlane({
      now: () => now,
      secretEncryptor: { encrypt: async (value) => value, decrypt: async (value) => value },
    });
    const runtime = await createLambdaRuntime({
      auth: new AuthService({ mode: "disabled" }),
      created: { plane, storage: undefined } as never,
      management: { send: async () => ({}) },
    });
    await plane.createSlackIntegrationDurable({
      botToken,
      signingSecret,
      defaultChannel: "#harness",
    });

    const invoke = async (value: ReturnType<typeof event>) => {
      const body = JSON.stringify(value);
      return runtime.rest({
        body: Buffer.from(body).toString("base64"),
        isBase64Encoded: true,
        rawPath: "/api/v1/integrations/slack/events",
        headers: signSlackRaw(body, signingSecret),
        requestContext: { http: { method: "POST" } },
      });
    };

    await expect(invoke(event("T1", "A1", "Ev1"))).resolves.toMatchObject({ statusCode: 200 });
    await expect(invoke(event("T2", "A1", "Ev2"))).resolves.toMatchObject({ statusCode: 401 });
    await expect(invoke(event("T1", "A2", "Ev3"))).resolves.toMatchObject({ statusCode: 200 });
    const wrongBot = event("T1", "A1", "Ev4");
    wrongBot.authorizations = [{ user_id: "Uother" }];
    await expect(invoke(wrongBot)).resolves.toMatchObject({ statusCode: 401 });
    const missingAuthorization = event("T1", "A1", "Ev5") as Partial<ReturnType<typeof event>>;
    delete missingAuthorization.authorizations;
    await expect(invoke(missingAuthorization as ReturnType<typeof event>)).resolves.toMatchObject({
      statusCode: 401,
    });
  });
});
