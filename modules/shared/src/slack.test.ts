import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS, normalizeSlackNotifications } from "./slack.ts";

describe("Slack shared contract", () => {
  it("defaults lifecycle notifications on and schedule notifications off", () => {
    expect(DEFAULT_SLACK_NOTIFICATIONS).toEqual({
      onSessionCreated: true,
      onSessionStarted: true,
      onSessionCompleted: true,
      onSessionFailed: true,
      onSessionCancelled: true,
      onScheduleCompleted: false,
      onHostOffline: true,
    });
    expect(normalizeSlackNotifications({ onHostOffline: false }).onHostOffline).toBe(false);
  });
});
