import { SLACK_SECRET_ENCRYPTION_CONTEXT, type SecretEncryptor } from "./secret-crypto.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  SLACK_INTEGRATION_ID,
  toPublicSlackIntegration,
  type PublicSlackIntegration,
  type SlackIntegrationRecord,
  type SlackNotifications,
} from "./slack-integration-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

type SlackSecretConfig = { botToken: string; signingSecret?: string };

export type SlackConfigInput = {
  botToken: string;
  signingSecret?: string;
  defaultChannel: string;
  enabled?: boolean;
  notifications?: SlackNotifications;
};

type SlackConfigFailure = { ok: false; error: string; conflict?: true; unavailable?: true };

export function getSlackIntegration(state: ControlPlaneState): PublicSlackIntegration | null {
  return state.slackIntegration ? toPublicSlackIntegration(state.slackIntegration) : null;
}

export async function getSlackIntegrationDurable(
  state: ControlPlaneState,
): Promise<PublicSlackIntegration | null> {
  if (!state.storage) return getSlackIntegration(state);
  const record = await state.storage.getSlackIntegration();
  state.slackIntegration = record ? { ...record } : undefined;
  return record ? toPublicSlackIntegration(record) : null;
}

export async function createSlackIntegrationDurable(
  state: ControlPlaneState,
  input: SlackConfigInput,
): Promise<{ ok: true; integration: PublicSlackIntegration } | SlackConfigFailure> {
  const valid = validateInput(input);
  if (!valid.ok) return valid;
  const encryptor = state.secretEncryptor;
  if (!encryptor) return unavailable();
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (current) return { ok: false, error: "Slack integration already exists", conflict: true };
  const at = state.now();
  const record = await makeRecord(input, encryptor, at, 1, at);
  if (!state.storage) {
    state.slackIntegration = record;
    return { ok: true, integration: toPublicSlackIntegration(record) };
  }
  if (!(await state.storage.putSlackIntegration(record, null))) {
    await getSlackIntegrationDurable(state);
    return conflict();
  }
  state.slackIntegration = record;
  return { ok: true, integration: toPublicSlackIntegration(record) };
}

export async function updateSlackIntegrationDurable(
  state: ControlPlaneState,
  input: SlackConfigInput,
): Promise<{ ok: true; integration: PublicSlackIntegration } | SlackConfigFailure> {
  const valid = validateInput(input);
  if (!valid.ok) return valid;
  const encryptor = state.secretEncryptor;
  if (!encryptor) return unavailable();
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (!current) return { ok: false, error: "Slack integration not found" };
  const record = await makeRecord(
    input,
    encryptor,
    current.createdAt,
    current.version + 1,
    state.now(),
  );
  if (!state.storage) {
    state.slackIntegration = record;
    return { ok: true, integration: toPublicSlackIntegration(record) };
  }
  if (!(await state.storage.putSlackIntegration(record, current.version))) {
    await getSlackIntegrationDurable(state);
    return conflict();
  }
  state.slackIntegration = record;
  return { ok: true, integration: toPublicSlackIntegration(record) };
}

export async function deleteSlackIntegrationDurable(
  state: ControlPlaneState,
): Promise<{ ok: true } | SlackConfigFailure> {
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (!current) return { ok: false, error: "Slack integration not found" };
  if (!state.storage) {
    state.slackIntegration = undefined;
    return { ok: true };
  }
  if (!(await state.storage.deleteSlackIntegration(current.version))) {
    await getSlackIntegrationDurable(state);
    return conflict();
  }
  state.slackIntegration = undefined;
  return { ok: true };
}

function unavailable(): SlackConfigFailure {
  return { ok: false, error: "Slack secret encryption is not configured", unavailable: true };
}

function conflict(): SlackConfigFailure {
  return { ok: false, error: "Slack integration changed concurrently; retry", conflict: true };
}

async function makeRecord(
  input: SlackConfigInput,
  encryptor: SecretEncryptor,
  createdAt: string,
  version: number,
  updatedAt: string,
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
    notifications: input.notifications ?? { ...DEFAULT_SLACK_NOTIFICATIONS },
    signingSecretConfigured: !!input.signingSecret,
    version,
    createdAt,
    updatedAt,
  };
}

function validateInput(input: SlackConfigInput): { ok: true } | SlackConfigFailure {
  if (!isSlackBotToken(input.botToken)) {
    return { ok: false, error: "botToken must be a Slack bot token" };
  }
  if (!isSlackChannel(input.defaultChannel)) {
    return { ok: false, error: "defaultChannel must be a Slack channel name or channel ID" };
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (input.signingSecret !== undefined && !isSigningSecret(input.signingSecret)) {
    return { ok: false, error: "signingSecret must be a Slack signing secret" };
  }
  if (input.notifications !== undefined) {
    const expected = Object.keys(DEFAULT_SLACK_NOTIFICATIONS).toSorted();
    const actual = Object.keys(input.notifications).toSorted();
    if (
      actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index]) ||
      !Object.values(input.notifications).every((value) => typeof value === "boolean")
    ) {
      return { ok: false, error: "notifications must contain only supported boolean event flags" };
    }
  }
  return { ok: true };
}

function isSlackChannel(value: string): boolean {
  return /^#[a-z0-9][a-z0-9_-]{0,79}$/.test(value) || /^[CGD][A-Z0-9]{8,}$/.test(value);
}

function isSlackBotToken(value: string): boolean {
  return /^xoxb-[A-Za-z0-9-]{10,}$/.test(value);
}

function isSigningSecret(value: string): boolean {
  return /^[a-fA-F0-9]{32,128}$/.test(value);
}
