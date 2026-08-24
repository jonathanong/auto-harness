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
  deliveryAvailable: false,
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
  it("hides the delivery warning when outbound delivery is available", () => {
    const view = mountForm(
      <SlackSettingsForm
        initial={{ ...configured, deliveryAvailable: true, signingSecretConfigured: true }}
      />,
    );
    expect(view.container.querySelector('[data-pw="slack-delivery-warning"]')).toBeNull();
    expect(field(view.container, "slack-delivery-state").textContent).toBe("Available");
    expect(field(view.container, "slack-signing-secret-state").textContent).toBe("Configured");
  });

  it("does not promise delivery when the integration is disabled", () => {
    const view = mountForm(
      <SlackSettingsForm initial={{ ...configured, enabled: false, deliveryAvailable: true }} />,
    );
    expect(field(view.container, "slack-delivery-state").textContent).toBe("Disabled");
    expect(field(view.container, "slack-delivery-warning").textContent).toContain("disabled");
  });

  it("validates, creates, and surfaces save failures", async () => {
    createApiFake(json({ error: { message: "unavailable" } }, 503), json(configured));
    const view = mountForm(<SlackSettingsForm />);
    expect(field(view.container, "slack-delivery-warning").textContent).toContain(
      "outbound delivery is available",
    );
    expect(field(view.container, "slack-delivery-state").textContent).toBe("Not configured");
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
    expect(field(view.container, "slack-delivery-state").textContent).toContain("unavailable");
    expect(field(view.container, "slack-delivery-warning").textContent).toContain(
      "configured but delivery is unavailable",
    );
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

  it("handles missing form controls and a rejected delete response", async () => {
    createApiFake(json({ error: { message: "delete rejected" } }, 409));
    const missing = mountForm(<SlackSettingsForm />);
    field(missing.container, "slack-bot-token").remove();
    field(missing.container, "slack-signing-secret").remove();
    field(missing.container, "slack-default-channel").remove();
    submit(field(missing.container, "form-slack-create"));
    expect(field(missing.container, "slack-error").textContent).toContain("required");
    missing.unmount();

    const configuredView = mountForm(<SlackSettingsForm initial={configured} />);
    press(field(configuredView.container, "slack-delete"));
    press(field(document, "slack-delete-confirm-submit"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("delete rejected");
  });

  it("does not update state after save or delete completes on an unmounted form", async () => {
    let resolveSave!: (response: Response) => void;
    let resolveDelete!: (response: Response) => void;
    createApiFake(
      () => new Promise<Response>((resolve) => (resolveSave = resolve)),
      () => new Promise<Response>((resolve) => (resolveDelete = resolve)),
    );
    const saveView = mountForm(<SlackSettingsForm />);
    fillCreate(saveView);
    submit(field(saveView.container, "form-slack-create"));
    saveView.unmount();
    expect(saveView.container.childElementCount).toBe(0);
    resolveSave(json(configured));
    await settle();

    const deleteView = mountForm(<SlackSettingsForm initial={configured} />);
    press(field(deleteView.container, "slack-delete"));
    press(field(document, "slack-delete-confirm-submit"));
    deleteView.unmount();
    expect(deleteView.container.childElementCount).toBe(0);
    resolveDelete(json({}, 204));
    await settle();
  });
});
