import { SLACK_SECRET_ENCRYPTION_CONTEXT, type SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";

export async function slackDeliveryAvailable(
  state: { slackOutboundEnabled: boolean; secretEncryptor?: SecretEncryptor | undefined },
  record: SlackIntegrationRecord,
): Promise<boolean> {
  if (!state.slackOutboundEnabled) return false;
  return (await resolveSlackBotToken(state.secretEncryptor, record)) !== null;
}

export function isSlackBotToken(value: string): boolean {
  return /^xoxb-[A-Za-z0-9-]{10,}$/.test(value);
}

/** Decrypts the bot token only. Returns null if KMS, JSON, or token shape fails closed. */
export async function resolveSlackBotToken(
  encryptor: SecretEncryptor | undefined,
  record: SlackIntegrationRecord,
): Promise<string | null> {
  if (!encryptor) return null;
  try {
    const parsed: unknown = JSON.parse(
      await encryptor.decrypt(record.encryptedConfig, SLACK_SECRET_ENCRYPTION_CONTEXT),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const botToken = (parsed as { botToken?: unknown }).botToken;
    return typeof botToken === "string" && isSlackBotToken(botToken) ? botToken : null;
  } catch {
    return null;
  }
}
