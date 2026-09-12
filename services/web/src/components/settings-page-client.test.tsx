// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { dismissToast } from "@auto-harness/ui";

import {
  createRequestFake,
  field,
  json,
  mountForm,
} from "../../test-helpers/form-test-helpers.tsx";
import { safeSettingsReturnPath, SettingsPageClient } from "./settings-page-client.tsx";

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SettingsPageClient", () => {
  it("keeps relative settings paths and rejects open redirects", () => {
    expect(safeSettingsReturnPath("/settings", "?tab=slack")).toBe("/settings?tab=slack");
    expect(safeSettingsReturnPath("//evil.example/", "")).toBe("/settings");
    expect(safeSettingsReturnPath("/settings\\evil", "")).toBe("/settings");
    expect(safeSettingsReturnPath("https://evil.example/", "")).toBe("/settings");
  });

  it("shows loading, then the unconfigured and configured states", async () => {
    let finish!: (response: Response) => void;
    const request = createRequestFake(new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", request.request);
    const loading = mountForm(<SettingsPageClient />, { pathname: "/settings" });
    expect(field(loading.container, "slack-settings-loading").getAttribute("aria-busy")).toBe(
      "true",
    );
    await act(async () => finish(new Response(null, { status: 404 })));
    expect(field(loading.container, "form-slack-create")).toBeTruthy();
    loading.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          id: "slack",
          type: "slack",
          defaultChannel: "#ops",
          enabled: true,
          notifications: {
            onSessionStarted: true,
            onSessionCompleted: true,
            onSessionFailed: true,
            onApprovalRequired: true,
          },
          botTokenConfigured: true,
          signingSecretConfigured: false,
          deliveryAvailable: false,
          version: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const configured = mountForm(<SettingsPageClient />);
    await settle();
    expect(field(configured.container, "form-slack-replace")).toBeTruthy();
  });

  it("shows bounded OAuth results and strips unknown callback values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    window.history.replaceState(null, "", "/settings/slack?slackOAuth=success");
    const connected = mountForm(<SettingsPageClient />, { pathname: "/settings/slack" });
    await settle();
    expect(field(document, "slack-oauth-status").textContent).toContain("Slack connected");
    expect(window.location.search).toBe("");
    connected.unmount();
    dismissToast();

    window.history.replaceState(null, "", "/settings/slack?slackOAuth=unexpected");
    const unknown = mountForm(<SettingsPageClient />, { pathname: "/settings/slack" });
    await settle();
    expect(window.location.search).toBe("");
    expect(document.body.querySelector('[data-pw="slack-oauth-status"]')).toBeNull();
    unknown.unmount();
  });

  it("preserves unrelated settings queries and renders OAuth failure status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    window.history.replaceState(null, "", "/settings/slack?tab=slack&slackOAuth=error");
    const failed = mountForm(<SettingsPageClient />, { pathname: "/settings/slack" });
    await settle();
    expect(field(document, "slack-oauth-status").textContent).toContain("could not complete");
    expect(window.location.search).toBe("?tab=slack");
    failed.unmount();
    dismissToast();
  });

  it("renders forbidden and request-error states", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    const forbidden = mountForm(<SettingsPageClient />);
    await settle();
    expect(field(forbidden.container, "settings-forbidden-error").textContent).toContain(
      "permission",
    );
    forbidden.unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const failed = mountForm(<SettingsPageClient />);
    await settle();
    expect(field(failed.container, "settings-load-error").textContent).toContain("Unable");
    failed.unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const rejected = mountForm(<SettingsPageClient />);
    await settle();
    expect(field(rejected.container, "settings-load-error")).toBeTruthy();
  });

  it("redirects unauthorized loads and ignores responses after cleanup", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/settings");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const unauthorized = mountForm(<SettingsPageClient />, { pathname: "/settings" });
    await settle();
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fsettings");
    unauthorized.unmount();

    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const cleaned = mountForm(<SettingsPageClient />);
    cleaned.unmount();
    await act(async () => finish(new Response(null, { status: 404 })));
  });

  it("ignores a rejected Slack load after unmount", async () => {
    let fail!: (reason: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((_, reject) => (fail = reject))),
    );
    const view = mountForm(<SettingsPageClient />);
    view.unmount();
    await act(async () => fail(new Error("offline")));
  });
});
