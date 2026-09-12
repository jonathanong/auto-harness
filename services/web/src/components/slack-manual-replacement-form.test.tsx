// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  field,
  mountForm,
  press,
  setValue,
  submit,
} from "../../test-helpers/form-test-helpers.tsx";
import { SlackManualReplacementForm } from "./slack-manual-replacement-form.tsx";
import type { SlackIntegration } from "./slack-settings.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-settings.ts";

const config: SlackIntegration = {
  id: "slack",
  type: "slack",
  defaultChannel: "#harness",
  enabled: true,
  notifications: DEFAULT_SLACK_NOTIFICATIONS,
  botTokenConfigured: true,
  signingSecretConfigured: false,
  deliveryAvailable: false,
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  installationMethod: "oauth",
  inboundAvailable: true,
};

describe("SlackManualReplacementForm", () => {
  it("keeps validation errors adjacent to the credential form", () => {
    const onError = vi.fn();
    const view = mountForm(
      <SlackManualReplacementForm
        config={config}
        error={null}
        pending={false}
        onError={onError}
        onSave={vi.fn()}
      />,
    );
    submit(field(view.container, "form-slack-manual-replace"));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Bot token"));
  });

  it("submits credentials while preserving delivery settings", () => {
    const onSave = vi.fn();
    const view = mountForm(
      <SlackManualReplacementForm
        config={config}
        error="Previous error"
        pending={false}
        onError={vi.fn()}
        onSave={onSave}
      />,
    );
    expect(field(view.container, "slack-manual-error").textContent).toContain("Previous error");
    setValue(field<HTMLInputElement>(view.container, "slack-bot-token"), "xoxb-1234567890-manual");
    setValue(field<HTMLInputElement>(view.container, "slack-signing-secret"), "not-hex-secret-1");
    submit(field(view.container, "form-slack-manual-replace"));
    expect(onSave).toHaveBeenCalledWith(
      expect.any(HTMLFormElement),
      expect.objectContaining({
        botToken: "xoxb-1234567890-manual",
        signingSecret: "not-hex-secret-1",
        defaultChannel: "#harness",
        enabled: true,
      }),
    );
  });

  it("disables the submit while saving", () => {
    const view = mountForm(
      <SlackManualReplacementForm
        config={config}
        error={null}
        pending
        onError={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(field<HTMLButtonElement>(view.container, "slack-manual-submit").disabled).toBe(true);
    press(field(view.container, "slack-manual-submit"));
  });

  it("permits an optional empty signing secret when replacing OAuth credentials", () => {
    const onSave = vi.fn();
    const view = mountForm(
      <SlackManualReplacementForm
        config={config}
        error={null}
        pending={false}
        onError={vi.fn()}
        onSave={onSave}
      />,
    );
    setValue(field<HTMLInputElement>(view.container, "slack-bot-token"), "xoxb-1234567890-manual");
    submit(field(view.container, "form-slack-manual-replace"));
    expect(onSave).toHaveBeenCalledWith(
      expect.any(HTMLFormElement),
      expect.objectContaining({ signingSecret: "" }),
    );
  });
});
