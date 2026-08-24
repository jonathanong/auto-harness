export const SLACK_INTEGRATION_ID = "slack";

export type SlackNotifications = {
  onSessionCreated: boolean;
  onSessionStarted: boolean;
  onSessionCompleted: boolean;
  onSessionFailed: boolean;
  onSessionCancelled: boolean;
  onScheduleCompleted: boolean;
};

export const DEFAULT_SLACK_NOTIFICATIONS: SlackNotifications = {
  onSessionCreated: true,
  onSessionStarted: true,
  onSessionCompleted: true,
  onSessionFailed: true,
  onSessionCancelled: true,
  onScheduleCompleted: false,
};

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
  const { encryptedConfig: _encryptedConfig, ...publicRecord } = record;
  return { ...publicRecord, botTokenConfigured: true, deliveryAvailable };
}
