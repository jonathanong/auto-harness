import { describe, expect, it } from "vitest";

import { SLACK_SECRET_ENCRYPTION_CONTEXT, type SecretEncryptor } from "./secret-crypto.ts";
import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type SlackIntegrationRecord,
} from "./slack-integration-types.ts";
import { isSlackBotToken, resolveSlackBotToken, slackDeliveryAvailable } from "./slack-secrets.ts";

const token = "xoxb-1234567890-abcdefghij";

function record(encryptedConfig = "ciphertext"): SlackIntegrationRecord {
  return {
    id: "slack",
    type: "slack",
    encryptedConfig,
    defaultChannel: "#harness",
    enabled: true,
    notifications: { ...DEFAULT_SLACK_NOTIFICATIONS },
    signingSecretConfigured: false,
    version: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

describe("Slack secret resolution", () => {
  it("accepts bot tokens and decrypts only a valid secret payload", async () => {
    expect(isSlackBotToken(token)).toBe(true);
    expect(isSlackBotToken("xoxp-not-a-bot")).toBe(false);
    expect(await resolveSlackBotToken(undefined, record())).toBeNull();

    const roundTrip: SecretEncryptor = {
      encrypt: async (plaintext) => plaintext,
      decrypt: async (ciphertext, context) => {
        expect(context).toEqual(SLACK_SECRET_ENCRYPTION_CONTEXT);
        return ciphertext;
      },
    };
    expect(
      await resolveSlackBotToken(
        roundTrip,
        record(JSON.stringify({ botToken: token, signingSecret: "a".repeat(32) })),
      ),
    ).toBe(token);
    expect(await resolveSlackBotToken(roundTrip, record("not-json"))).toBeNull();
    expect(await resolveSlackBotToken(roundTrip, record("[]"))).toBeNull();
    expect(await resolveSlackBotToken(roundTrip, record("null"))).toBeNull();
    expect(await resolveSlackBotToken(roundTrip, record("{}"))).toBeNull();
    expect(
      await resolveSlackBotToken(roundTrip, record(JSON.stringify({ botToken: "xoxp-nope" }))),
    ).toBeNull();
    expect(
      await resolveSlackBotToken(roundTrip, record(JSON.stringify({ botToken: 1 }))),
    ).toBeNull();

    const failing: SecretEncryptor = {
      encrypt: async () => "x",
      decrypt: async () => {
        throw new Error("kms");
      },
    };
    expect(await resolveSlackBotToken(failing, record())).toBeNull();
  });

  it("treats delivery as unavailable until outbound is enabled and the token decrypts", async () => {
    const encryptor: SecretEncryptor = {
      encrypt: async (plaintext) => plaintext,
      decrypt: async (ciphertext) => ciphertext,
    };
    const stored = record(JSON.stringify({ botToken: token }));
    expect(
      await slackDeliveryAvailable(
        { slackOutboundEnabled: false, secretEncryptor: encryptor },
        stored,
      ),
    ).toBe(false);
    expect(await slackDeliveryAvailable({ slackOutboundEnabled: true }, stored)).toBe(false);
    expect(
      await slackDeliveryAvailable(
        { slackOutboundEnabled: true, secretEncryptor: encryptor },
        stored,
      ),
    ).toBe(true);
  });
});
