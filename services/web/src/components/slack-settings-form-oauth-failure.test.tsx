// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  setValue,
  submit,
} from "../../test-helpers/form-test-helpers.tsx";
import { readSlackFormValues } from "./slack-delivery-settings-form.tsx";
import { SlackSettingsForm } from "./slack-settings-form.tsx";
import { DEFAULT_SLACK_NOTIFICATIONS, type SlackIntegration } from "./slack-settings.ts";

const oauth: SlackIntegration = {
  id: "slack",
  type: "slack",
  defaultChannel: "#harness",
  enabled: true,
  notifications: DEFAULT_SLACK_NOTIFICATIONS,
  botTokenConfigured: true,
  signingSecretConfigured: false,
  deliveryAvailable: false,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  installationMethod: "oauth",
  inboundAvailable: true,
};

describe("Slack OAuth delivery settings failure", () => {
  it("keeps a mounted PATCH failure adjacent to the delivery form", async () => {
    createApiFake(() => Promise.reject(new Error("offline")));
    const view = mountForm(<SlackSettingsForm initial={oauth} />);
    submit(field(view.container, "form-slack-settings"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(view.container, "slack-error").textContent).toContain(
      "Unable to save Slack configuration",
    );
    expect(
      field(view.container, "form-slack-manual-replace").querySelector(
        '[data-pw="slack-manual-error"]',
      ),
    ).toBeNull();
  });

  it("keeps an OAuth PATCH HTTP failure adjacent to the delivery form", async () => {
    createApiFake(json({ error: { message: "settings changed concurrently" } }, 409));
    const view = mountForm(<SlackSettingsForm initial={oauth} />);
    submit(field(view.container, "form-slack-settings"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(view.container, "slack-error").textContent).toContain(
      "settings changed concurrently",
    );
  });

  it("keeps manual replacement validation errors in the manual form", () => {
    const view = mountForm(<SlackSettingsForm initial={oauth} />);
    submit(field(view.container, "form-slack-manual-replace"));
    expect(field(view.container, "slack-manual-error").textContent).toContain("Bot token");
    expect(
      field(view.container, "form-slack-settings").querySelector('[data-pw="slack-error"]'),
    ).toBeNull();
  });

  it("keeps a mounted manual replacement HTTP failure in the manual form", async () => {
    createApiFake(json({ error: { message: "manual replacement rejected" } }, 409));
    const view = mountForm(<SlackSettingsForm initial={oauth} />);
    setValue(field<HTMLInputElement>(view.container, "slack-bot-token"), "xoxb-1234567890-test");
    submit(field(view.container, "form-slack-manual-replace"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(view.container, "slack-manual-error").textContent).toContain(
      "manual replacement rejected",
    );
  });

  it("serializes unchecked delivery controls as false", () => {
    const form = document.createElement("form");
    form.innerHTML = [
      '<input name="enabled" type="checkbox">',
      '<input name="onSessionCreated" type="checkbox">',
      '<input name="onSessionStarted" type="checkbox">',
      '<input name="onSessionCompleted" type="checkbox">',
      '<input name="onSessionFailed" type="checkbox">',
      '<input name="onSessionCancelled" type="checkbox">',
      '<input name="onScheduleCompleted" type="checkbox">',
      '<input name="onHostOffline" type="checkbox">',
    ].join("");
    const values = readSlackFormValues(oauth, form);
    expect(values.enabled).toBe(false);
    expect(Object.values(values.notifications).every((value) => value === false)).toBe(true);
  });
});
