import { randomUUID } from "node:crypto";

import { SLACK_SECRET_ENCRYPTION_CONTEXT } from "./secret-crypto.ts";
import {
  SLACK_INTEGRATION_ID,
  type PublicSlackIntegration,
  type SlackIntegrationRecord,
  type SlackNotifications,
} from "./slack-integration-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { isSlackBotToken } from "./slack-secrets.ts";
import { publicIntegration, type SlackConfigFailure } from "./control-plane-slack.ts";
import { slackConfigConflict, slackConfigUnavailable } from "./control-plane-slack-failure.ts";
import type { SlackOAuthExchange } from "./slack-oauth-types.ts";

export type SlackOAuthInstallInput = {
  expectedVersion: number | null;
  /** Optional for compatibility with callers and state records created before identity fencing. */
  expectedInstallationId?: string | null;
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
  exchange: SlackOAuthExchange;
};

export async function installSlackOAuthIntegrationDurable(
  state: ControlPlaneState,
  input: SlackOAuthInstallInput,
): Promise<{ ok: true; integration: PublicSlackIntegration } | SlackConfigFailure> {
  if (!isSlackBotToken(input.exchange.botToken) || !validOAuthExchange(input.exchange))
    return { ok: false, error: "Slack OAuth response was invalid" };
  if (!state.secretEncryptor) return slackConfigUnavailable();
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (
    current?.installationMethod === "oauth" &&
    (current.workspaceId !== input.exchange.workspaceId || current.appId !== input.exchange.appId)
  )
    return { ok: false, error: "Slack OAuth installation does not match the existing workspace" };
  if ((current?.version ?? null) !== input.expectedVersion) return slackConfigConflict();
  if (
    input.expectedInstallationId !== undefined &&
    (current?.installationId ?? null) !== input.expectedInstallationId
  )
    return slackConfigConflict();
  const at = state.now();
  const record: SlackIntegrationRecord = {
    id: SLACK_INTEGRATION_ID,
    type: "slack",
    encryptedConfig: await state.secretEncryptor.encrypt(
      JSON.stringify({ botToken: input.exchange.botToken }),
      SLACK_SECRET_ENCRYPTION_CONTEXT,
    ),
    defaultChannel: input.defaultChannel,
    enabled: input.enabled,
    notifications: input.notifications,
    signingSecretConfigured: false,
    installationMethod: "oauth",
    workspaceId: input.exchange.workspaceId,
    ...(input.exchange.workspaceName ? { workspaceName: input.exchange.workspaceName } : {}),
    appId: input.exchange.appId,
    ...(input.exchange.botUserId ? { botUserId: input.exchange.botUserId } : {}),
    grantedScopes: input.exchange.scopes,
    installationId: current?.installationId ?? randomUUID(),
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? at,
    updatedAt: at,
  };
  if (!state.storage) {
    state.slackIntegration = record;
    return { ok: true, integration: await publicIntegration(state, record) };
  }
  const stored =
    "expectedInstallationId" in input
      ? await state.storage.putSlackIntegration(
          record,
          input.expectedVersion,
          input.expectedInstallationId,
        )
      : await state.storage.putSlackIntegration(record, input.expectedVersion);
  if (!stored) return slackConfigConflict();
  state.slackIntegration = record;
  return { ok: true, integration: await publicIntegration(state, record) };
}

function validOAuthExchange(exchange: SlackOAuthExchange): boolean {
  return (
    /^[A-Z0-9]+$/.test(exchange.workspaceId) &&
    /^[A-Z0-9]+$/.test(exchange.appId) &&
    ["chat:write", "app_mentions:read", "im:history"].every((scope) =>
      exchange.scopes.includes(scope),
    )
  );
}
