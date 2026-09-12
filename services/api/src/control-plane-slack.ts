import { randomUUID } from "node:crypto";

import {
  normalizeSlackNotifications,
  toPublicSlackIntegration,
  type PublicSlackIntegration,
  type SlackIntegrationRecord,
  type SlackNotifications,
} from "./slack-integration-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { resolveSlackSigningSecret, slackDeliveryAvailable } from "./slack-secrets.ts";
import {
  makeManualSlackRecord,
  validateSlackConfig,
  validateSlackSettingsPatch,
} from "./control-plane-slack-manual.ts";
import { slackConfigConflict, slackConfigUnavailable } from "./control-plane-slack-failure.ts";
import { resolveManualSlackIdentity } from "./control-plane-slack-manual-identity.ts";

export type SlackConfigInput = {
  botToken: string;
  signingSecret?: string;
  defaultChannel: string;
  enabled?: boolean;
  /** The former six-event payload omits onHostOffline and is normalized on write. */
  notifications?: Partial<SlackNotifications>;
};

/** PATCH deliberately cannot replace either credential. */
export type SlackSettingsPatch = {
  /** Version read by the editor; prevents a stale form from replacing newer settings. */
  expectedVersion: number;
  defaultChannel?: string;
  enabled?: boolean;
  notifications?: Partial<SlackNotifications>;
};

export type SlackConfigFailure = { ok: false; error: string; conflict?: true; unavailable?: true };

export function getSlackIntegration(
  state: ControlPlaneState,
): Promise<PublicSlackIntegration | null> {
  return state.slackIntegration
    ? publicIntegration(state, state.slackIntegration)
    : Promise.resolve(null);
}

export async function getSlackIntegrationDurable(
  state: ControlPlaneState,
): Promise<PublicSlackIntegration | null> {
  if (!state.storage) {
    return state.slackIntegration ? publicIntegration(state, state.slackIntegration) : null;
  }
  const record = await state.storage.getSlackIntegration();
  state.slackIntegration = record ? { ...record } : undefined;
  return record ? publicIntegration(state, record) : null;
}

export async function createSlackIntegrationDurable(
  state: ControlPlaneState,
  input: SlackConfigInput,
): Promise<{ ok: true; integration: PublicSlackIntegration } | SlackConfigFailure> {
  const valid = validateSlackConfig(input);
  if (!valid.ok) return valid;
  const encryptor = state.secretEncryptor;
  if (!encryptor) return slackConfigUnavailable();
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (current) return { ok: false, error: "Slack integration already exists", conflict: true };
  const at = state.now();
  const record = await makeManualSlackRecord(
    input,
    encryptor,
    at,
    1,
    at,
    undefined,
    await resolveManualSlackIdentity(state, input),
  );
  if (!state.storage) {
    state.slackIntegration = record;
    return { ok: true, integration: await publicIntegration(state, record) };
  }
  if (!(await state.storage.putSlackIntegration(record, null))) {
    await getSlackIntegrationDurable(state);
    return slackConfigConflict();
  }
  state.slackIntegration = record;
  return { ok: true, integration: await publicIntegration(state, record) };
}

export async function updateSlackIntegrationDurable(
  state: ControlPlaneState,
  input: SlackConfigInput,
): Promise<{ ok: true; integration: PublicSlackIntegration } | SlackConfigFailure> {
  const valid = validateSlackConfig(input);
  if (!valid.ok) return valid;
  const encryptor = state.secretEncryptor;
  if (!encryptor) return slackConfigUnavailable();
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (!current) return { ok: false, error: "Slack integration not found" };
  const record = await makeManualSlackRecord(
    input,
    encryptor,
    current.createdAt,
    current.version + 1,
    state.now(),
    current.installationId,
    await resolveManualSlackIdentity(state, input),
  );
  if (!state.storage) {
    state.slackIntegration = record;
    return { ok: true, integration: await publicIntegration(state, record) };
  }
  if (!(await state.storage.putSlackIntegration(record, current.version))) {
    await getSlackIntegrationDurable(state);
    return slackConfigConflict();
  }
  state.slackIntegration = record;
  return { ok: true, integration: await publicIntegration(state, record) };
}

export async function patchSlackIntegrationDurable(
  state: ControlPlaneState,
  input: SlackSettingsPatch,
): Promise<{ ok: true; integration: PublicSlackIntegration } | SlackConfigFailure> {
  const valid = validateSlackSettingsPatch(input);
  if (!valid.ok) return valid;
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if (!current) return { ok: false, error: "Slack integration not found" };
  if (current.version !== input.expectedVersion) {
    state.slackIntegration = { ...current };
    return slackConfigConflict();
  }
  const record: SlackIntegrationRecord = {
    ...current,
    ...(input.defaultChannel === undefined ? {} : { defaultChannel: input.defaultChannel }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.notifications === undefined
      ? {}
      : {
          notifications: normalizeSlackNotifications({
            ...current.notifications,
            ...input.notifications,
          }),
        }),
    version: current.version + 1,
    installationId: current.installationId ?? randomUUID(),
    updatedAt: state.now(),
  };
  if (!state.storage) {
    state.slackIntegration = record;
    return { ok: true, integration: await publicIntegration(state, record) };
  }
  if (!(await state.storage.putSlackIntegration(record, input.expectedVersion))) {
    await getSlackIntegrationDurable(state);
    return slackConfigConflict();
  }
  state.slackIntegration = record;
  return { ok: true, integration: await publicIntegration(state, record) };
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
    return slackConfigConflict();
  }
  state.slackIntegration = undefined;
  return { ok: true };
}

export async function publicIntegration(
  state: ControlPlaneState,
  record: SlackIntegrationRecord,
): Promise<PublicSlackIntegration> {
  const inboundAvailable =
    (record.installationMethod ?? "manual") === "oauth"
      ? state.slackInboundEnabled
      : Boolean(record.workspaceId && record.botUserId) &&
        (await resolveSlackSigningSecret(state.secretEncryptor, record)) !== null;
  return {
    ...toPublicSlackIntegration(record, await slackDeliveryAvailable(state, record)),
    inboundAvailable,
  };
}
