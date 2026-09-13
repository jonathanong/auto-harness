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
import CustomWebhookSettingsPage from "../app/settings/custom-webhooks/page.tsx";

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

function offline() {
  return Promise.reject(new Error("offline"));
}

describe("CustomWebhookSettings", () => {
  it("accepts the full positive fractional API timeout range", () => {
    const view = mountForm(<CustomWebhookSettings />);
    const timeout = field<HTMLInputElement>(view.container, "custom-webhook-timeout");
    expect(timeout.min).toBe("0.001");
    expect(timeout.max).toBe("604800");
    expect(timeout.step).toBe("any");
    view.unmount();
  });

  it("loads existing state, edits structured routing, retains a blank secret, and deletes", async () => {
    const fake = createApiFake(json(existing), json({ ...existing, version: 3 }), json({}, 204));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-repository").value).toBe("repo");
    setValue(field(view.container, "custom-webhook-queue-ttl"), "7200");
    setValue(field(view.container, "custom-webhook-priority"), "7");
    setValue(field(view.container, "custom-webhook-target-type"), "commandId");
    setValue(field(view.container, "custom-webhook-target"), "command");
    setValue(field(view.container, "custom-webhook-label-0"), "ready");
    setValue(field(view.container, "custom-webhook-fallback-type-0"), "providerId");
    setValue(field(view.container, "custom-webhook-fallback-id-0"), "backup");
    setValue(field(view.container, "custom-webhook-timeout"), "240");
    press(field(view.container, "custom-webhook-enabled"));
    press(field(view.container, "custom-webhook-add-label"));
    press(field(view.container, "custom-webhook-add-fallback"));
    const addedLabel = field(view.container, "custom-webhook-label-1").parentElement;
    const addedFallback = field(view.container, "custom-webhook-fallback-id-1").parentElement;
    if (!addedLabel || !addedFallback) throw new Error("missing dynamic rows");
    press(addedLabel.querySelector("button")!);
    press(addedFallback.querySelector("button")!);
    submit(view.container.querySelector("form")!);
    await settle();
    const save = fake.requests[1]?.[1];
    expect(save?.method).toBe("PUT");
    expect(JSON.parse(String(save?.body))).not.toHaveProperty("secret");
    expect(JSON.parse(String(save?.body))).toMatchObject({ version: 2, generation: "legacy" });
    expect(field(view.container, "custom-webhook-delete")).toBeInstanceOf(HTMLButtonElement);
    press(field(view.container, "custom-webhook-delete"));
    expect(document.body.textContent).toContain("Delete custom webhook configuration?");
    expect(fake.requests).toHaveLength(2);
    press(field(document, "custom-webhook-delete-confirm-submit"));
    await settle();
    expect(fake.requests[2]?.[1]?.method).toBe("DELETE");
    expect(fake.requests[2]?.[1]?.headers).toMatchObject({ "if-match": "3" });
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

  it("does not reuse a loaded integration when its id changes", async () => {
    const fake = createApiFake(json(existing), json({ ...existing, id: "other" }, 201));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "other");
    expect(view.container.querySelector('[data-pw="custom-webhook-delete"]')).toBeNull();
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-secret"), "s".repeat(32));
    submit(view.container.querySelector("form")!);
    await settle();
    expect(fake.requests[1]?.[0]).toBe("/api/v1/integrations/custom/other");
    expect(fake.requests[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fake.requests[1]?.[1]?.body))).not.toHaveProperty("version");
  });

  it("does not restore configuration when a save finishes after its id changes", async () => {
    let resolveSave!: (response: Response) => void;
    const fake = createApiFake(
      json(existing),
      () => new Promise<Response>((resolve) => (resolveSave = resolve)),
    );
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    submit(view.container.querySelector("form")!);
    expect(fake.requests[1]?.[0]).toBe("/api/v1/integrations/custom/deploy");
    expect(fake.requests[1]?.[1]?.method).toBe("PUT");
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "other");
    resolveSave(json({ ...existing, version: 3 }));
    await settle();
    expect(view.container.querySelector('[data-pw="custom-webhook-delete"]')).toBeNull();
    view.unmount();
  });

  it("keeps a secret edited while the save is in flight", async () => {
    let resolveSave!: (response: Response) => void;
    createApiFake(
      json(existing),
      () => new Promise<Response>((resolve) => (resolveSave = resolve)),
    );
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-secret"), "old-secret");
    submit(view.container.querySelector("form")!);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-secret"), "new-secret");
    resolveSave(json({ ...existing, version: 3 }));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-secret").value).toBe(
      "new-secret",
    );
    view.unmount();
  });

  it("does not clear a different configuration when a delete finishes late", async () => {
    let resolveDelete!: (response: Response) => void;
    createApiFake(
      json(existing),
      () => new Promise<Response>((resolve) => (resolveDelete = resolve)),
    );
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    press(field(view.container, "custom-webhook-delete"));
    press(field(document, "custom-webhook-delete-confirm-submit"));
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "other");
    resolveDelete(json({}, 204));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-id").value).toBe("other");
    expect(view.container.querySelector('[data-pw="custom-webhook-delete"]')).toBeNull();
    view.unmount();
  });

  it("ignores a stale load response after the integration id changes", async () => {
    let resolveLoad!: (response: Response) => void;
    createApiFake(() => new Promise<Response>((resolve) => (resolveLoad = resolve)));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "other");
    resolveLoad(json(existing));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-id").value).toBe("other");
    expect(view.container.querySelector('[data-pw="custom-webhook-delete"]')).toBeNull();
    view.unmount();
  });

  it("ignores a load response whose payload belongs to another integration", async () => {
    createApiFake(json({ ...existing, id: "other" }));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(view.container.querySelector('[data-pw="custom-webhook-delete"]')).toBeNull();
    view.unmount();
  });

  it("renders empty fallback rows without an identifier", async () => {
    createApiFake(json({ ...existing, fallbacks: [{}] }));
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-fallback-id-0").value).toBe("");
    view.unmount();
  });

  it("names dynamic required-label controls for assistive technology", async () => {
    const view = mountForm(<CustomWebhookSettings />);
    press(field(view.container, "custom-webhook-add-label"));
    expect(view.container.querySelector('[aria-label="Required label 1"]')).toBeInstanceOf(
      HTMLInputElement,
    );
    view.unmount();
  });

  it("normalizes optional loaded routing fields and updates later dynamic rows", async () => {
    createApiFake(
      json({
        ...existing,
        target: {},
        fallbacks: undefined,
        requiredLabels: undefined,
      }),
    );
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(field<HTMLInputElement>(view.container, "custom-webhook-target").value).toBe("");
    press(field(view.container, "custom-webhook-add-label"));
    press(field(view.container, "custom-webhook-add-label"));
    setValue(field(view.container, "custom-webhook-label-1"), "release");
    press(field(view.container, "custom-webhook-add-fallback"));
    press(field(view.container, "custom-webhook-add-fallback"));
    setValue(field(view.container, "custom-webhook-fallback-id-1"), "backup");
    view.unmount();
  });

  it("hides dynamic add controls when the loaded configuration reaches routing limits", async () => {
    createApiFake(
      json({
        ...existing,
        requiredLabels: Array.from({ length: 16 }, (_, index) => `label-${index}`),
        fallbacks: Array.from({ length: 90 }, (_, index) => ({ providerId: `provider-${index}` })),
      }),
    );
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(view.container.querySelector('[data-pw="custom-webhook-add-label"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="custom-webhook-add-fallback"]')).toBeNull();
    view.unmount();
  });

  it("reports load, save, and delete failures", async () => {
    const fake = createApiFake(
      json({}, 404),
      json({ error: { code: "NO" } }, 500),
      json(existing),
      json({ error: { code: "NO" } }, 400),
      json(existing),
      json({ error: { code: "NO" } }, 409),
    );
    const view = mountForm(<CustomWebhookSettings />);
    press(field(view.container, "custom-webhook-load"));
    expect(document.body.textContent).toContain("Enter an integration id");
    setValue(field(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(document.body.textContent).toContain("No configuration exists");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(document.body.textContent).toContain("Unable to load");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    submit(view.container.querySelector("form")!);
    await settle();
    expect(document.body.textContent).toContain("Unable to save");
    submit(view.container.querySelector("form")!);
    await settle();
    press(field(view.container, "custom-webhook-delete"));
    press(field(document, "custom-webhook-delete-confirm-submit"));
    await settle();
    expect(document.body.textContent).toContain("Unable to delete");
    expect(fake.requests).toHaveLength(6);
  });

  it("reports rejected load, save, and delete requests", async () => {
    const fake = createApiFake(offline, json(existing), offline, offline);
    const view = mountForm(<CustomWebhookSettings />);
    setValue(field<HTMLInputElement>(view.container, "custom-webhook-id"), "deploy");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    expect(document.body.textContent).toContain("Unable to load");
    press(field(view.container, "custom-webhook-load"));
    await settle();
    submit(view.container.querySelector("form")!);
    await settle();
    expect(document.body.textContent).toContain("Unable to save");
    press(field(view.container, "custom-webhook-delete"));
    press(field(document, "custom-webhook-delete-confirm-submit"));
    await settle();
    expect(document.body.textContent).toContain("Unable to delete");
    expect(fake.requests).toHaveLength(4);
  });

  it("renders the settings page wrapper", () => {
    const view = mountForm(<CustomWebhookSettingsPage />);
    expect(field(view.container, "custom-webhook-settings-card")).toBeInstanceOf(HTMLElement);
  });
});
