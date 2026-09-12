import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SlackInboundIntegration } from "./slack-integration-types.ts";
import { resolveSlackSigningSecret } from "./slack-secrets.ts";

/**
 * Reads only the metadata and signing secret required to verify public Slack events.
 * In particular, it never evaluates delivery availability or resolves a bot token.
 */
export async function getSlackInboundIntegrationDurable(
  state: ControlPlaneState,
): Promise<SlackInboundIntegration | null> {
  const record = state.storage ? await state.storage.getSlackIntegration() : state.slackIntegration;
  state.slackIntegration = record ? { ...record } : undefined;
  if (!record) return null;
  const installationMethod = record.installationMethod ?? "manual";
  return {
    installationMethod,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.appId ? { appId: record.appId } : {}),
    ...(record.botUserId ? { botUserId: record.botUserId } : {}),
    signingSecret:
      installationMethod === "manual"
        ? await resolveSlackSigningSecret(state.secretEncryptor, record)
        : null,
  };
}
