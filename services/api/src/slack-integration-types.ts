import { type PublicSlackIntegration, type SlackNotifications } from "@auto-harness/shared";

export const SLACK_INTEGRATION_ID = "slack";
export { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";
export type { PublicSlackIntegration, SlackNotifications } from "@auto-harness/shared";

/** The sole durable record. `encryptedConfig` must never reach REST output. */
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

export function toPublicSlackIntegration(record: SlackIntegrationRecord): PublicSlackIntegration {
  const { encryptedConfig: _encryptedConfig, ...publicRecord } = record;
  return { ...publicRecord, botTokenConfigured: true };
}
