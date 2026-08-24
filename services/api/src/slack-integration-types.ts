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
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicSlackIntegration = Omit<SlackIntegrationRecord, "encryptedConfig"> & {
  botTokenConfigured: true;
  deliveryAvailable: boolean;
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
    deliveryAvailable,
  };
}
