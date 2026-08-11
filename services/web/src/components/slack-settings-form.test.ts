import { describe, expect, it } from "vitest";

import {
  buildSlackConfigBody,
  DEFAULT_SLACK_NOTIFICATIONS,
  validateSlackForm,
  type SlackFormValues,
} from "./slack-settings.ts";

const values = (overrides: Partial<SlackFormValues> = {}): SlackFormValues => ({
  botToken: "xoxb-test-token",
  signingSecret: "",
  defaultChannel: "#harness",
  enabled: true,
  notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
  ...overrides,
});

describe("Slack settings form", () => {
  it("validates required write-only credentials and channel formats", () => {
    expect(validateSlackForm(values({ botToken: "" }))).toContain("required");
    expect(validateSlackForm(values({ botToken: "not-a-token" }))).toContain("xoxb-");
    expect(validateSlackForm(values({ defaultChannel: "" }))).toContain("required");
    expect(validateSlackForm(values({ defaultChannel: "general" }))).toContain("channel name");
    expect(validateSlackForm(values({ defaultChannel: "C0123ABCDE" }))).toBeNull();
  });

  it("builds a complete replacement payload without blank optional secrets", () => {
    expect(buildSlackConfigBody(values())).toEqual({
      botToken: "xoxb-test-token",
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
    });
    expect(
      buildSlackConfigBody(values({ signingSecret: "new-signing-secret", enabled: false })),
    ).toMatchObject({ signingSecret: "new-signing-secret", enabled: false });
  });
});
