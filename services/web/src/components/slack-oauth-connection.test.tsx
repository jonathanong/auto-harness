// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  press,
} from "../../test-helpers/form-test-helpers.tsx";
import { SlackOAuthConnection } from "./slack-oauth-connection.tsx";
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
  installationId: "installation-2",
  inboundAvailable: true,
};

async function settle() {
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

describe("SlackOAuthConnection", () => {
  it("starts OAuth and navigates to Slack", async () => {
    const api = createApiFake(json({ url: "https://slack.com/oauth/v2/authorize?state=test" }));
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const onStart = vi.fn();
    const view = mountForm(
      <SlackOAuthConnection config={config} pending={false} onStart={onStart} />,
    );
    press(field(view.container, "slack-reconnect"));
    await settle();
    expect(onStart).toHaveBeenCalled();
    expect(JSON.parse(String(api.requests[0]?.[1]?.body))).toMatchObject({
      expectedVersion: 2,
      expectedInstallationId: "installation-2",
    });
    expect(assign).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?state=test");
    assign.mockRestore();
  });

  it("handles invalid OAuth URLs, HTTP errors, and network failures", async () => {
    const onStart = vi.fn();
    createApiFake(json({ url: "https://evil.example/authorize" }));
    const invalid = mountForm(
      <SlackOAuthConnection config={config} pending={false} onStart={onStart} />,
    );
    press(field(invalid.container, "slack-reconnect"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("not available");
    invalid.unmount();

    createApiFake(json({ error: { message: "unavailable" } }, 503));
    const failed = mountForm(
      <SlackOAuthConnection config={config} pending={false} onStart={onStart} />,
    );
    press(field(failed.container, "slack-reconnect"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("unavailable");
    failed.unmount();

    createApiFake(() => Promise.reject(new Error("offline")));
    const offline = mountForm(
      <SlackOAuthConnection config={config} pending={false} onStart={onStart} />,
    );
    press(field(offline.container, "slack-reconnect"));
    await settle();
    expect(field(document.body, "slack-error").textContent).toContain("Unable to start");
  });

  it("disables while a connection is pending and ignores late results after unmount", async () => {
    let resolve!: (response: Response) => void;
    createApiFake(() => new Promise<Response>((next) => (resolve = next)));
    const view = mountForm(
      <SlackOAuthConnection config={config} pending={false} onStart={vi.fn()} />,
    );
    press(field(view.container, "slack-reconnect"));
    expect(field<HTMLButtonElement>(view.container, "slack-reconnect").disabled).toBe(true);
    view.unmount();
    resolve(json({ error: { message: "late" } }, 503));
    await settle();
    expect(document.body.textContent ?? "").not.toContain("late");
  });

  it("starts a first connection with default settings and a null version fence", async () => {
    const api = createApiFake(json({ url: "https://slack.com/oauth/v2/authorize?state=first" }));
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const view = mountForm(<SlackOAuthConnection pending={false} onStart={vi.fn()} />);
    expect(field(view.container, "slack-connect").textContent).toContain("Connect with Slack");
    press(field(view.container, "slack-connect"));
    await settle();
    expect(JSON.parse(String(api.requests[0]?.[1]?.body))).toMatchObject({
      defaultChannel: "#harness",
      enabled: true,
      expectedVersion: null,
    });
    expect(assign).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?state=first");
    assign.mockRestore();
  });

  it("does not show invalid-response or network-error toasts after unmount", async () => {
    let resolveInvalid!: (response: Response) => void;
    createApiFake(() => new Promise<Response>((resolve) => (resolveInvalid = resolve)));
    const invalid = mountForm(<SlackOAuthConnection pending={false} onStart={vi.fn()} />);
    press(field(invalid.container, "slack-connect"));
    invalid.unmount();
    resolveInvalid(json({ url: null }));
    await settle();
    expect(document.body.textContent ?? "").not.toContain("not available");

    let rejectNetwork!: (error: Error) => void;
    createApiFake(() => new Promise<Response>((_resolve, reject) => (rejectNetwork = reject)));
    const offline = mountForm(<SlackOAuthConnection pending={false} onStart={vi.fn()} />);
    press(field(offline.container, "slack-connect"));
    offline.unmount();
    rejectNetwork(new Error("offline"));
    await settle();
    expect(document.body.textContent ?? "").not.toContain("Unable to start");
  });
});
