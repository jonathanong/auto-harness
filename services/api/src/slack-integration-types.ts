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
  /** Missing on rows created before OAuth support; normalize as manual. */
  installationMethod?: "manual" | "oauth";
  workspaceId?: string;
  workspaceName?: string;
  appId?: string;
  botUserId?: string;
  grantedScopes?: string[];
  /** Opaque identity for this singleton installation; absent on legacy rows. */
  installationId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicSlackIntegration = Omit<SlackIntegrationRecord, "encryptedConfig"> & {
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
  const { encryptedConfig: _encryptedConfig, notifications, ...publicRecord } = record;
  return {
    ...publicRecord,
    notifications: normalizeSlackNotifications(notifications),
    botTokenConfigured: true,
    installationMethod: record.installationMethod ?? "manual",
    inboundAvailable: record.signingSecretConfigured,
    deliveryAvailable,
  };
}
