import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { resolveManualSlackIdentity } from "./control-plane-slack-manual-identity.ts";
import { slackTestEncryptor } from "../test-helpers/slack-route-test-helpers.ts";

const input = {
  botToken: "xoxb-1234567890-abcdefghij",
  defaultChannel: "#harness",
  signingSecret: "manual-signing-secret-123456",
};

describe("Slack inbound identity boundaries", () => {
  it("rejects malformed manual identities and requires a verified bot user", async () => {
    const plane = new ControlPlane({ secretEncryptor: slackTestEncryptor });
    plane.state.slackIdentityClient = {
      authTestBotToken: async () => ({ workspaceId: "bad-workspace", appId: "A1" }),
    };
    await expect(resolveManualSlackIdentity(plane.state, input)).resolves.toBeUndefined();

    plane.state.slackIdentityClient = {
      authTestBotToken: async () => ({
        workspaceId: "T1",
        workspaceName: "Workspace",
        appId: "A1",
        botUserId: "bad-user",
      }),
    };
    await expect(resolveManualSlackIdentity(plane.state, input)).resolves.toBeUndefined();

    plane.state.slackIdentityClient = {
      authTestBotToken: async () => ({ workspaceId: "T1", appId: "A1", botUserId: "UBOT" }),
    };
    await expect(plane.createSlackIntegrationDurable(input)).resolves.toMatchObject({ ok: true });
    expect(plane.state.slackIntegration).toMatchObject({ botUserId: "UBOT" });
  });

  it("treats a legacy integration without an installation method as manual inbound", async () => {
    const plane = new ControlPlane({ secretEncryptor: slackTestEncryptor });
    await plane.createSlackIntegrationDurable(input);
    delete plane.state.slackIntegration!.installationMethod;
    delete plane.state.slackIntegration!.installationId;

    await expect(plane.getSlackInboundIntegrationDurable()).resolves.toMatchObject({
      installationMethod: "manual",
      signingSecret: input.signingSecret,
    });
    await expect(
      plane.patchSlackIntegrationDurable({ expectedVersion: 1, enabled: false }),
    ).resolves.toMatchObject({ ok: true, integration: { enabled: false } });
    expect(plane.state.slackIntegration?.installationId).toEqual(expect.any(String));
  });
});
