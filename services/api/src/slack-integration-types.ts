import {
  DEFAULT_SLACK_NOTIFICATIONS,
  normalizeSlackNotifications,
  type SlackNotifications,
} from "@auto-harness/shared";

export const SLACK_INTEGRATION_ID = "slack";
export { DEFAULT_SLACK_NOTIFICATIONS, normalizeSlackNotifications, type SlackNotifications };

/** The singleton durable record. Ciphertext must never leave the API boundary. */
export type SlackIntegrationRecord = {
  id: typeof SLACK_INTEGRATION_ID;
  type: "slack";
  encryptedConfig: string;
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
  signingSecretConfigured: boolean;
  installationMethod: "manual" | "oauth";
  workspaceId?: string;
  workspaceName?: string;
  appId?: string;
  botUserId?: string;
  grantedScopes?: string[];
  /** Opaque identity for this singleton installation; absent on legacy rows. */
  installationId?: string;
  /**
   * The most recent delivery failure, cleared on the next successful delivery. `message`
   * is always the outbox row's already-sanitized `lastError` (never a token or secret —
   * `slackError()` in slack-http-transport.ts never includes the bot token). Written by a
   * narrow, unconditioned-on-version update (`recordSlackDeliveryOutcome`) so an operator
   * editing settings concurrently never loses this write to a version conflict, and vice
   * versa.
   */
  lastDeliveryFailure?: { message: string; at: string };
  /** Internal ordering fence for worker-owned delivery status. Never exposed publicly. */
  lastDeliveryOutcomeAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** Outcome of one durable delivery attempt, recorded on the integration row so Settings
 * can show *why* Slack isn't working without querying the deliveries table. */
export type SlackDeliveryOutcome =
  | { ok: true; at: string; installationId: string | null }
  | { ok: false; error: string; at: string; installationId: string | null };

export type PublicSlackIntegration = Omit<
  SlackIntegrationRecord,
  "encryptedConfig" | "lastDeliveryOutcomeAt"
> & {
  botTokenConfigured: true;
  deliveryAvailable: boolean;
  installationMethod: "manual" | "oauth";
  inboundAvailable: boolean;
};

/**
 * Secret-minimal view used by the unauthenticated Slack events route. It deliberately
 * excludes bot-token delivery configuration and public capability probes.
 */
export type SlackInboundIntegration = {
  installationMethod: "manual" | "oauth";
  workspaceId?: string;
  appId?: string;
  /** Manual ingress fence derived from Slack auth.test's user_id. */
  botUserId?: string;
  signingSecret: string | null;
};

export function toPublicSlackIntegration(
  record: SlackIntegrationRecord,
  deliveryAvailable = false,
): PublicSlackIntegration {
  const {
    encryptedConfig: _encryptedConfig,
    lastDeliveryOutcomeAt: _lastDeliveryOutcomeAt,
    notifications,
    ...publicRecord
  } = record;
  return {
    ...publicRecord,
    notifications: normalizeSlackNotifications(notifications),
    botTokenConfigured: true,
    installationMethod: record.installationMethod ?? "manual",
    inboundAvailable: record.signingSecretConfigured,
    deliveryAvailable,
  };
}
