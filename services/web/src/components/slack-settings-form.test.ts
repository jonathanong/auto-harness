import { describe, expect, it } from "vitest";

import {
  buildSlackConfigBody,
  DEFAULT_SLACK_NOTIFICATIONS,
  initialSlackFormValues,
  responseMessage,
  slackDeliveryWarning,
  slackSaveSuccessMessage,
  validateSlackForm,
  type SlackFormValues,
} from "./slack-settings.ts";

const values = (overrides: Partial<SlackFormValues> = {}): SlackFormValues => ({
  botToken: "xoxb-1234567890-test",
  signingSecret: "",
  defaultChannel: "#harness",
  enabled: true,
  notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
  ...overrides,
});

describe("Slack settings form", () => {
  it("validates required secrets, channel formats, and signing secrets", () => {
    expect(validateSlackForm(values({ botToken: "" }))).toContain("required");
    expect(validateSlackForm(values({ botToken: "not-a-token" }))).toContain("xoxb-");
    expect(validateSlackForm(values({ defaultChannel: "" }))).toContain("required");
    expect(validateSlackForm(values({ defaultChannel: "general" }))).toContain("channel name");
    expect(validateSlackForm(values({ defaultChannel: "C0123ABCDE" }))).toBeNull();
    expect(validateSlackForm(values({ signingSecret: "not-secret" }))).toContain("hexadecimal");
    expect(validateSlackForm(values({ signingSecret: "a".repeat(32) }))).toBeNull();
  });

  it("builds a complete replacement payload without blank optional secrets", () => {
    expect(buildSlackConfigBody(values())).toEqual({
      botToken: "xoxb-1234567890-test",
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
    });
    expect(
      buildSlackConfigBody(values({ signingSecret: "a".repeat(32), enabled: false })),
    ).toMatchObject({ signingSecret: "a".repeat(32), enabled: false });
  });

  it("initializes only non-secret configuration values", () => {
    expect(initialSlackFormValues()).toEqual({
      botToken: "",
      signingSecret: "",
      defaultChannel: "#harness",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
    });
    expect(
      initialSlackFormValues({
        id: "slack",
        type: "slack",
        defaultChannel: "C0123ABCDE",
        enabled: false,
        notifications: { ...DEFAULT_SLACK_NOTIFICATIONS, onSessionStarted: false },
        botTokenConfigured: true,
        signingSecretConfigured: true,
        deliveryAvailable: false,
        version: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual(
      values({
        botToken: "",
        signingSecret: "",
        defaultChannel: "C0123ABCDE",
        enabled: false,
        notifications: { ...DEFAULT_SLACK_NOTIFICATIONS, onSessionStarted: false },
      }),
    );
  });

  it("reports configured-but-unavailable until delivery can actually send", () => {
    expect(slackDeliveryWarning()).toContain("outbound delivery is available");
    expect(
      slackDeliveryWarning({
        id: "slack",
        type: "slack",
        defaultChannel: "#harness",
        enabled: true,
        notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
        botTokenConfigured: true,
        signingSecretConfigured: false,
        deliveryAvailable: false,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toContain("configured but delivery is unavailable");
    expect(
      slackDeliveryWarning({
        id: "slack",
        type: "slack",
        defaultChannel: "#harness",
        enabled: true,
        notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
        botTokenConfigured: true,
        signingSecretConfigured: false,
        deliveryAvailable: true,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      slackSaveSuccessMessage({
        id: "slack",
        type: "slack",
        defaultChannel: "#harness",
        enabled: true,
        notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
        botTokenConfigured: true,
        signingSecretConfigured: false,
        deliveryAvailable: true,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toContain("will be delivered");
    expect(
      slackSaveSuccessMessage({
        id: "slack",
        type: "slack",
        defaultChannel: "#harness",
        enabled: true,
        notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
        botTokenConfigured: true,
        signingSecretConfigured: false,
        deliveryAvailable: false,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toContain("configured but delivery is unavailable");
  });

  it("uses a server error message only when it is safe to display", async () => {
    await expect(
      responseMessage(
        new Response(JSON.stringify({ error: { message: "Configuration is unavailable" } }), {
          status: 503,
        }),
      ),
    ).resolves.toBe("Configuration is unavailable");
    await expect(responseMessage(new Response("not JSON", { status: 502 }))).resolves.toBe(
      "Slack configuration request failed (502).",
    );
    await expect(
      responseMessage(
        new Response(JSON.stringify({ error: { message: "x".repeat(240) } }), { status: 400 }),
      ),
    ).resolves.toBe("Slack configuration request failed (400).");
  });
});
