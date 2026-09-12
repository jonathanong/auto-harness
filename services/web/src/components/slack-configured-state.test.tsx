// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "../../test-helpers/form-test-helpers.tsx";
import { SlackConfiguredState } from "./slack-configured-state.tsx";
import type { SlackIntegration } from "./slack-settings.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-settings.ts";

const config: SlackIntegration = {
  id: "slack",
  type: "slack",
  defaultChannel: "#harness",
  enabled: true,
  notifications: DEFAULT_SLACK_NOTIFICATIONS,
  botTokenConfigured: true,
  signingSecretConfigured: true,
  deliveryAvailable: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("SlackConfiguredState", () => {
  it("renders the unconfigured state", () => {
    const view = mountForm(<SlackConfiguredState />);
    expect(field(view.container, "slack-installation-method-state").textContent).toBe(
      "Manual token",
    );
    expect(field(view.container, "slack-delivery-state").textContent).toBe("Not configured");
    expect(field(view.container, "slack-bot-token-state").textContent).toBe("Not configured");
  });

  it("renders disabled and unavailable manual states", () => {
    const view = mountForm(
      <SlackConfiguredState config={{ ...config, enabled: false, deliveryAvailable: true }} />,
    );
    expect(field(view.container, "slack-delivery-state").textContent).toBe("Disabled");
    view.unmount();
    const unavailable = mountForm(
      <SlackConfiguredState config={{ ...config, deliveryAvailable: false }} />,
    );
    expect(field(unavailable.container, "slack-delivery-state").textContent).toBe(
      "Configured but delivery unavailable",
    );
  });

  it("renders OAuth installation metadata and inbound state", () => {
    const view = mountForm(
      <SlackConfiguredState
        config={{
          ...config,
          installationMethod: "oauth",
          inboundAvailable: true,
          workspaceId: "T01234567",
          workspaceName: "Harness",
          appId: "A01234567",
          grantedScopes: ["chat:write", "app_mentions:read"],
        }}
      />,
    );
    expect(field(view.container, "slack-installation-method-state").textContent).toBe("OAuth");
    expect(field(view.container, "slack-workspace-state").textContent).toContain("Harness");
    expect(field(view.container, "slack-app-state").textContent).toBe("A01234567");
    expect(field(view.container, "slack-scopes-state").textContent).toContain("app_mentions:read");
    expect(field(view.container, "slack-inbound-state").textContent).toBe("Available");
    view.unmount();
    const unavailable = mountForm(
      <SlackConfiguredState
        config={{ ...config, installationMethod: "oauth", inboundAvailable: false }}
      />,
    );
    expect(field(unavailable.container, "slack-inbound-state").textContent).toBe("Unavailable");
  });

  it("renders delivery availability, legacy workspace identifiers, and meaningful scopes", () => {
    const view = mountForm(
      <SlackConfiguredState
        config={{
          ...config,
          inboundAvailable: true,
          workspaceId: "T01234567",
          grantedScopes: ["", "chat:write"],
        }}
      />,
    );
    expect(field(view.container, "slack-delivery-state").textContent).toBe("Available");
    expect(field(view.container, "slack-inbound-state").textContent).toBe("Available");
    expect(field(view.container, "slack-workspace-state").textContent).toBe("T01234567");
    expect(field(view.container, "slack-scopes-state").textContent).toContain("chat:write");
    expect(field(view.container, "slack-signing-secret-state").textContent).toBe("Configured");
  });
});
