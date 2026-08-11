import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack.ts";

describe("Slack shared contract", () => {
  it("keeps lifecycle notifications enabled by default except schedules", () => {
    expect(DEFAULT_SLACK_NOTIFICATIONS).toEqual({
      onSessionCreated: true,
      onSessionStarted: true,
      onSessionCompleted: true,
      onSessionFailed: true,
      onSessionCancelled: true,
      onScheduleCompleted: false,
    });
  });
});
