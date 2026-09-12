import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { isPublicSlackIngressRoute } from "./local-routes-slack-public.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";
import {
  signSlackBody as sign,
  slackTestCredentials as credentials,
  slackTestNow as now,
} from "../test-helpers/slack-route-test-helpers.ts";

describe("pre-install Slack events", () => {
  it("recognizes only exact public Slack ingress routes", () => {
    expect(isPublicSlackIngressRoute("GET", "/api/v1/integrations/slack/oauth/callback")).toBe(
      true,
    );
    expect(isPublicSlackIngressRoute("POST", "/api/v1/integrations/slack/events")).toBe(true);
    expect(isPublicSlackIngressRoute("POST", "/api/v1/integrations/slack/oauth/callback")).toBe(
      false,
    );
    expect(isPublicSlackIngressRoute("POST", "/api/v1/integrations/slack/events/more")).toBe(false);
  });

  it("verifies a signed URL challenge but does not accept an event", async () => {
    const app = createLocalApp({
      plane: new ControlPlane({ now: () => now }),
      authMode: "disabled",
      slackAppCredentials: credentials,
    });
    const challenge = { type: "url_verification", challenge: "challenge" };
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        challenge,
        sign(challenge),
      ),
    ).toMatchObject({ status: 200, json: { challenge: "challenge" } });
    const event = {
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
    };
    expect(
      await invokeHandler(
        app.handler,
        "POST",
        "/api/v1/integrations/slack/events",
        event,
        sign(event),
      ),
    ).toMatchObject({ status: 401 });
  });

  it("rate limits public callbacks and signed events by source address before dispatch", async () => {
    const plane = new ControlPlane({ now: () => now });
    const rateEvents: string[] = [];
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      rateLimitConfig: { limits: { publicIngress: 1 } },
      rateLimitNow: () => Date.parse(now),
      onRateLimitEvent: (event) => rateEvents.push(`${event.bucket}:${event.outcome}`),
    });
    const challenge = { type: "url_verification", challenge: "challenge" };

    const callback = await invokeHandler(
      app.handler,
      "GET",
      "/api/v1/integrations/slack/oauth/callback",
      undefined,
      {},
      "198.51.100.10",
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("x-ratelimit-limit")).toBe(1);
    expect(callback.headers.get("x-ratelimit-remaining")).toBe(0);

    expect(
      (
        await invokeHandler(
          app.handler,
          "POST",
          "/api/v1/integrations/slack/events",
          challenge,
          sign(challenge),
          "198.51.100.11",
        )
      ).status,
    ).toBe(200);
    const denied = await invokeHandler(
      app.handler,
      "POST",
      "/api/v1/integrations/slack/events",
      challenge,
      sign(challenge),
      "198.51.100.11",
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("x-ratelimit-limit")).toBe(1);
    expect(denied.headers.get("x-ratelimit-remaining")).toBe(0);
    expect(denied.headers.get("retry-after")).toBe(60);
    expect(rateEvents).toEqual([
      "publicIngress:allowed",
      "publicIngress:allowed",
      "publicIngress:denied",
    ]);
    expect((await plane.listAuditLogs()).items).toEqual([]);
  });
});
