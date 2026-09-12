import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseSlackInboundEvent, verifySlackRequest } from "./slack-inbound.ts";

const now = "2026-09-12T00:00:00.000Z";
const secret = "a".repeat(32);

function signature(body: Buffer, timestamp = "1789171200"): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
}

describe("Slack inbound verification and normalization", () => {
  it("verifies exact raw v0 request bytes within the replay window", () => {
    const body = Buffer.from('{"event_id":"Ev1"}');
    expect(
      verifySlackRequest({
        rawBody: body,
        timestamp: "1789171200",
        signature: signature(body),
        signingSecret: secret,
        nowMs: Date.parse(now),
      }),
    ).toBe(true);
    expect(
      verifySlackRequest({
        rawBody: Buffer.from("{}"),
        timestamp: "1789171200",
        signature: signature(body),
        signingSecret: secret,
        nowMs: Date.parse(now),
      }),
    ).toBe(false);
    expect(
      verifySlackRequest({
        rawBody: body,
        timestamp: "1789171200",
        signature: signature(body),
        signingSecret: secret,
        nowMs: Number.NaN,
      }),
    ).toBe(false);
    expect(
      verifySlackRequest({
        rawBody: body,
        timestamp: "1789170800",
        signature: signature(body, "1789170800"),
        signingSecret: secret,
        nowMs: Date.parse(now),
      }),
    ).toBe(false);
    expect(
      verifySlackRequest({
        rawBody: body,
        signature: signature(body),
        signingSecret: secret,
        nowMs: Date.parse(now),
      }),
    ).toBe(false);
  });

  it("returns a challenge and queues only human mentions and DMs without raw envelope fields", () => {
    expect(
      parseSlackInboundEvent({ type: "url_verification", challenge: "challenge" }, now),
    ).toEqual({ challenge: "challenge" });
    const parsed = parseSlackInboundEvent(
      {
        type: "event_callback",
        team_id: "T123",
        api_app_id: "A123",
        authorizations: [{ user_id: "UBOT" }],
        event_id: "Ev123",
        event: { type: "app_mention", channel: "C123", user: "U123", text: "hello", ts: "1.2" },
      },
      now,
    );
    expect(parsed).toEqual({
      event: expect.objectContaining({
        workspaceId: "T123",
        apiAppId: "A123",
        authorizedUserIds: ["UBOT"],
        eventId: "Ev123",
        type: "app_mention",
        status: "pending",
      }),
    });
    expect((parsed as { event: Record<string, unknown> }).event).not.toHaveProperty("rawBody");
    expect(
      parseSlackInboundEvent(
        {
          type: "event_callback",
          team_id: "T123",
          event_id: "Ev123",
          event: {
            type: "message",
            channel_type: "im",
            channel: "D1",
            user: "U1",
            text: "dm",
            ts: "1",
          },
        },
        now,
      ),
    ).toMatchObject({ event: { type: "message.im" } });
    expect(
      parseSlackInboundEvent(
        {
          type: "event_callback",
          team_id: "T123",
          event_id: "Ev123",
          event: {
            type: "app_mention",
            bot_id: "B1",
            channel: "C1",
            user: "U1",
            text: "loop",
            ts: "1",
          },
        },
        now,
      ),
    ).toEqual({});
    expect(
      parseSlackInboundEvent(
        {
          type: "event_callback",
          team_id: "T123",
          event_id: "Ev123",
          event: { type: "reaction_added" },
        },
        now,
      ),
    ).toEqual({});
    for (const malformed of [
      {
        type: "event_callback",
        team_id: "bad",
        event_id: "Ev1",
        event: { type: "app_mention", channel: "C1", user: "U1", text: "x", ts: "1" },
      },
      {
        type: "event_callback",
        team_id: "T1",
        api_app_id: 1,
        event_id: "Ev1",
        event: { type: "app_mention", channel: "C1", user: "U1", text: "x", ts: "1" },
      },
      {
        type: "event_callback",
        team_id: "T1",
        event_id: "",
        event: { type: "app_mention", channel: "C1", user: "U1", text: "x", ts: "1" },
      },
      {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        event: { type: "app_mention", channel: "bad", user: "U1", text: "x", ts: "1" },
      },
      {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        event: { type: "app_mention", channel: "C1", user: "bad", text: "x", ts: "bad" },
      },
    ])
      expect(parseSlackInboundEvent(malformed, now)).toEqual({});
  });

  it("rejects missing event bodies and invalid queue clocks", () => {
    expect(parseSlackInboundEvent(null, now)).toBeNull();
    expect(
      parseSlackInboundEvent({ type: "event_callback", team_id: "T1", event_id: "Ev1" }, now),
    ).toEqual({});
    expect(
      parseSlackInboundEvent(
        {
          type: "event_callback",
          team_id: "T1",
          event_id: "Ev1",
          event: {
            type: "app_mention",
            channel: "C1",
            user: "U1",
            text: "hello",
            ts: "1",
          },
        },
        "not-a-time",
      ),
    ).toBeNull();
  });
});
