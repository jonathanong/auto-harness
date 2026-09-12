import { SLACK_SECRET_ENCRYPTION_CONTEXT, type SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";

/** The API can act only on a definitive ownership result; unknown fails closed. */
export type SlackBotTokenOwnership = "owned" | "unowned" | "unknown";

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

/** Slack signing secrets are opaque printable strings, not necessarily hexadecimal. */
export function isSlackSigningSecret(value: string): boolean {
  return /^[\x21-\x7e]{16,128}$/.test(value);
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

/**
 * Compares a candidate with an integration's token without returning the durable plaintext.
 * Missing encryption, malformed ciphertext, and decrypt failures deliberately remain unknown.
 */
export async function slackBotTokenOwnership(
  encryptor: SecretEncryptor | undefined,
  record: SlackIntegrationRecord,
  candidate: string,
): Promise<SlackBotTokenOwnership> {
  if (!encryptor) return "unknown";
  try {
    const parsed: unknown = JSON.parse(
      await encryptor.decrypt(record.encryptedConfig, SLACK_SECRET_ENCRYPTION_CONTEXT),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
    const botToken = (parsed as { botToken?: unknown }).botToken;
    if (typeof botToken !== "string" || !isSlackBotToken(botToken)) return "unknown";
    return botToken === candidate ? "owned" : "unowned";
  } catch {
    return "unknown";
  }
}

/** Manual installations optionally keep their webhook signing secret with the bot token. */
export async function resolveSlackSigningSecret(
  encryptor: SecretEncryptor | undefined,
  record: SlackIntegrationRecord,
): Promise<string | null> {
  if (!encryptor) return null;
  try {
    const parsed: unknown = JSON.parse(
      await encryptor.decrypt(record.encryptedConfig, SLACK_SECRET_ENCRYPTION_CONTEXT),
    );
    const secret =
      parsed && typeof parsed === "object"
        ? (parsed as { signingSecret?: unknown }).signingSecret
        : undefined;
    return typeof secret === "string" && isSlackSigningSecret(secret) ? secret : null;
  } catch {
    return null;
  }
}
