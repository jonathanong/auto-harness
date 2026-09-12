import { randomUUID } from "node:crypto";

import { SLACK_SECRET_ENCRYPTION_CONTEXT, type SecretEncryptor } from "./secret-crypto.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  normalizeSlackNotifications,
  SLACK_INTEGRATION_ID,
  type SlackIntegrationRecord,
} from "./slack-integration-types.ts";
import { isSlackBotToken, isSlackSigningSecret } from "./slack-secrets.ts";
import type {
  SlackConfigFailure,
  SlackConfigInput,
  SlackSettingsPatch,
} from "./control-plane-slack.ts";
import type { SlackBotIdentity } from "./slack-oauth-types.ts";

type SlackSecretConfig = { botToken: string; signingSecret?: string };

export async function makeManualSlackRecord(
  input: SlackConfigInput,
  encryptor: SecretEncryptor,
  createdAt: string,
  version: number,
  updatedAt: string,
  installationId: string = randomUUID(),
  identity?: SlackBotIdentity,
): Promise<SlackIntegrationRecord> {
  const secretConfig: SlackSecretConfig = {
    botToken: input.botToken,
    ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
  };
  return {
    id: SLACK_INTEGRATION_ID,
    type: "slack",
    encryptedConfig: await encryptor.encrypt(
      JSON.stringify(secretConfig),
      SLACK_SECRET_ENCRYPTION_CONTEXT,
    ),
    defaultChannel: input.defaultChannel,
    enabled: input.enabled ?? true,
    notifications: normalizeSlackNotifications(input.notifications),
    signingSecretConfigured: !!input.signingSecret,
    installationMethod: "manual",
    ...(identity?.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(identity?.workspaceName ? { workspaceName: identity.workspaceName } : {}),
    ...(identity?.appId ? { appId: identity.appId } : {}),
    ...(identity?.botUserId ? { botUserId: identity.botUserId } : {}),
    installationId,
    version,
    createdAt,
    updatedAt,
  };
}

export function validateSlackConfig(input: SlackConfigInput): { ok: true } | SlackConfigFailure {
  if (!isSlackBotToken(input.botToken))
    return { ok: false, error: "botToken must be a Slack bot token" };
  if (!isSlackChannel(input.defaultChannel))
    return { ok: false, error: "defaultChannel must be a Slack channel name or channel ID" };
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    return { ok: false, error: "enabled must be a boolean" };
  if (input.signingSecret !== undefined && !isSlackSigningSecret(input.signingSecret))
    return { ok: false, error: "signingSecret must be a Slack signing secret" };
  if (input.notifications !== undefined) {
    const expected = Object.keys(DEFAULT_SLACK_NOTIFICATIONS).toSorted();
    const legacy = expected.filter((key) => key !== "onHostOffline");
    const actual = Object.keys(input.notifications).toSorted();
    if (
      (!sameKeys(actual, expected) && !sameKeys(actual, legacy)) ||
      !Object.values(input.notifications).every((value) => typeof value === "boolean")
    )
      return { ok: false, error: "notifications must contain only supported boolean event flags" };
  }
  return { ok: true };
}

export function isSlackChannel(value: string): boolean {
  return /^#[a-z0-9][a-z0-9_-]{0,79}$/.test(value) || /^[CGD][A-Z0-9]{8,}$/.test(value);
}

export function validateSlackSettingsPatch(
  input: SlackSettingsPatch,
): { ok: true } | SlackConfigFailure {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    return { ok: false, error: "expectedVersion must be a positive integer" };
  if (
    input.defaultChannel === undefined &&
    input.enabled === undefined &&
    input.notifications === undefined
  )
    return { ok: false, error: "at least one setting is required" };
  if (input.defaultChannel !== undefined && !isSlackChannel(input.defaultChannel))
    return { ok: false, error: "defaultChannel must be a Slack channel name or channel ID" };
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    return { ok: false, error: "enabled must be a boolean" };
  if (
    input.notifications !== undefined &&
    (Object.keys(input.notifications).some(
      (key) => !Object.hasOwn(DEFAULT_SLACK_NOTIFICATIONS, key),
    ) ||
      !Object.values(input.notifications).every((value) => typeof value === "boolean"))
  )
    return { ok: false, error: "notifications must contain only supported boolean event flags" };
  return { ok: true };
}

function sameKeys(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
