// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  press,
  router,
  setValue,
  submit,
} from "./form-test-helpers.tsx";
import { SlackSettingsForm } from "./slack-settings-form.tsx";
import type { PublicSlackIntegration } from "./slack-settings.ts";

const configured: PublicSlackIntegration = {
  id: "slack",
  type: "slack",
  defaultChannel: "#harness",
  enabled: true,
  notifications: {
    onSessionCreated: true,
    onSessionStarted: true,
    onSessionCompleted: true,
    onSessionFailed: true,
    onSessionCancelled: true,
    onScheduleCompleted: true,
  },
  botTokenConfigured: true,
  signingSecretConfigured: false,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function settle() {
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

function fillCreate(view: ReturnType<typeof mountForm>) {
  setValue(field<HTMLInputElement>(view.container, "slack-bot-token"), "xoxb-1234567890-test");
  setValue(field<HTMLInputElement>(view.container, "slack-default-channel"), "#harness");
}

describe("SlackSettingsForm", () => {
  it("validates, creates, and surfaces save failures", async () => {
    createApiFake(json({ error: { message: "unavailable" } }, 503), json(configured));
    const view = mountForm(<SlackSettingsForm />);
    submit(field(view.container, "form-slack-create"));
    expect(field(view.container, "slack-error").textContent).toContain("required");
    fillCreate(view);
    submit(field(view.container, "form-slack-create"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("unavailable");
    fillCreate(view);
    submit(field(view.container, "form-slack-create"));
    await settle();
    expect(field(view.container, "slack-ok").textContent).toContain("saved");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("replaces and deletes an existing configuration", async () => {
    createApiFake(json({ ...configured, version: 2 }), json({}, 204));
    const view = mountForm(<SlackSettingsForm initial={configured} />);
    setValue(field<HTMLInputElement>(view.container, "slack-bot-token"), "xoxb-1234567890-test");
    submit(field(view.container, "form-slack-replace"));
    await settle();
    expect(field(view.container, "slack-ok").textContent).toContain("saved");
    press(field(view.container, "slack-delete"));
    press(field(document, "slack-delete-confirm-submit"));
    await settle();
    expect(field(view.container, "slack-ok").textContent).toContain("deleted");
  });

  it("toasts network failures for save and delete", async () => {
    createApiFake(
      () => Promise.reject(new Error("offline")),
      () => Promise.reject(new Error("offline")),
    );
    const createView = mountForm(<SlackSettingsForm />);
    fillCreate(createView);
    submit(field(createView.container, "form-slack-create"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("Unable to save");
    createView.unmount();

    const deleteView = mountForm(<SlackSettingsForm initial={configured} />);
    press(field(deleteView.container, "slack-delete"));
    press(field(document, "slack-delete-confirm-submit"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("Unable to delete");
  });
});
