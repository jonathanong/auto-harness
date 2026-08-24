// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { SlackSettingsFields } from "./slack-settings-fields.tsx";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-settings.ts";

describe("SlackSettingsFields", () => {
  it("renders secure defaults and each default notification toggle", () => {
    const view = mountForm(<SlackSettingsFields error={null} />);
    const token = field<HTMLInputElement>(view.container, "slack-bot-token");
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("new-password");
    expect(token.required).toBe(true);
    expect(token.getAttribute("aria-describedby")).toBe("slack-secret-help");
    expect(token.getAttribute("aria-invalid")).toBe("false");
    expect(field<HTMLInputElement>(view.container, "slack-signing-secret").type).toBe("password");
    expect(field<HTMLInputElement>(view.container, "slack-default-channel").value).toBe("#harness");
    expect(field<HTMLInputElement>(view.container, "slack-enabled").checked).toBe(true);
    for (const key of Object.keys(DEFAULT_SLACK_NOTIFICATIONS) as Array<
      keyof typeof DEFAULT_SLACK_NOTIFICATIONS
    >) {
      expect(field<HTMLInputElement>(view.container, `slack-notification-${key}`).checked).toBe(
        DEFAULT_SLACK_NOTIFICATIONS[key],
      );
    }
  });

  it("renders configured checkbox states and connects errors accessibly", () => {
    const view = mountForm(
      <SlackSettingsFields
        error="Invalid Slack configuration"
        config={{
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
        }}
      />,
    );
    const token = field<HTMLInputElement>(view.container, "slack-bot-token");
    expect(token.getAttribute("aria-describedby")).toBe("slack-secret-help slack-error");
    expect(token.getAttribute("aria-invalid")).toBe("true");
    expect(field<HTMLInputElement>(view.container, "slack-default-channel").value).toBe(
      "C0123ABCDE",
    );
    expect(
      field<HTMLInputElement>(view.container, "slack-default-channel").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(field<HTMLInputElement>(view.container, "slack-enabled").checked).toBe(false);
    expect(
      field<HTMLInputElement>(view.container, "slack-notification-onSessionStarted").checked,
    ).toBe(false);
  });
});
