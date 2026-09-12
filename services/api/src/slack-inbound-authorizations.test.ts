import { describe, expect, it } from "vitest";

import { parseSlackInboundEvent } from "./slack-inbound.ts";

const event = {
  type: "event_callback",
  team_id: "T1",
  event_id: "Ev1",
  event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1" },
};

describe("Slack inbound authorization normalization", () => {
  it("retains valid bot user IDs for manual identity fencing", () => {
    expect(
      parseSlackInboundEvent(
        {
          ...event,
          authorizations: [{ user_id: "UBOT" }, { user_id: "UOTHER" }],
        },
        "2026-09-12T00:00:00.000Z",
      ),
    ).toMatchObject({ event: { authorizedUserIds: ["UBOT", "UOTHER"] } });
  });

  it("rejects malformed authorization entries", () => {
    expect(
      parseSlackInboundEvent(
        { ...event, authorizations: [{ user_id: "bad" }] },
        "2026-09-12T00:00:00.000Z",
      ),
    ).toEqual({});
    expect(
      parseSlackInboundEvent({ ...event, authorizations: [null] }, "2026-09-12T00:00:00.000Z"),
    ).toEqual({});
  });
});
