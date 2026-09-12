// @vitest-environment happy-dom
/* eslint-disable max-lines -- lifecycle and dynamic structured-control coverage share one fixture. */

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  press,
  setValue,
  submit,
} from "../../test-helpers/form-test-helpers.tsx";
import { CustomWebhookSettings } from "./custom-webhook-settings.tsx";

const existing = {
  id: "deploy",
  type: "custom-webhook",
  repositoryId: "repo",
  target: { providerId: "provider" },
  fallbacks: [{ commandId: "fallback" }],
  queueTtlSeconds: 3600,
  timeout: 120,
  priority: 5,
  requiredLabels: ["deploy"],
  enabled: true,
  secretConfigured: true,
  version: 2,
};

async function settle() {
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

describe("CustomWebhookSettings", () => {
  it("loads existing state, edits structured routing, retains a blank secret, and deletes", async () => {
    const fake = createApiFake(json(existing), json({ ...existing, version: 3 }), json({}, 204));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-repository").value).toBe("repo");
    press(field(view.container, "custom-webhook-add-label"));
    press(field(view.container, "custom-webhook-add-fallback"));
    submit(view.container.querySelector("form")!);
    await settle();
    const save = fake.requests[1]?.[1];
    expect(save?.method).toBe("PUT");
    expect(JSON.parse(String(save?.body))).not.toHaveProperty("secret");
    expect(field(view.container, "custom-webhook-delete")).toBeInstanceOf(HTMLButtonElement);
    press(field(view.container, "custom-webhook-delete"));
    await settle();
    expect(fake.requests[2]?.[1]?.method).toBe("DELETE");
    view.unmount();
  });

  it("requires a secret for a new configuration and does not update after unmount", async () => {
    let resolve!: (response: Response) => void;
    createApiFake(() => new Promise<Response>((done) => (resolve = done)));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "new-hook");
    submit(view.container.querySelector("form")!);
    expect(document.body.textContent).toContain("secret for a new integration");
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-secret"), "s".repeat(32));
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-repository"), "repo");
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-target"), "provider");
    submit(view.container.querySelector("form")!);
    view.unmount();
    resolve(json(existing));
    await settle();
  });
});
