import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import {
  isSlackChannel,
  makeManualSlackRecord,
  validateSlackConfig,
  validateSlackSettingsPatch,
} from "./control-plane-slack-manual.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";

const token = "xoxb-1234567890-abcdefghij";
const secret = "signing-secret-for-slack-events-123";

function input() {
  return { botToken: token, defaultChannel: "#harness" };
}

describe("manual Slack configuration validation", () => {
  it("writes defaults without optional secrets and preserves explicit settings", async () => {
    const encrypted: Array<{ value: string; context: unknown }> = [];
    const encryptor: SecretEncryptor = {
      encrypt: async (value, context) => {
        encrypted.push({ value, context });
        return "ciphertext";
      },
      decrypt: async () => "",
    };
    const defaults = await makeManualSlackRecord(input(), encryptor, "created", 1, "updated");
    const explicit = await makeManualSlackRecord(
      {
        ...input(),
        signingSecret: secret,
        enabled: false,
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
      },
      encryptor,
      "created",
      2,
      "updated",
    );

    expect(defaults).toMatchObject({
      encryptedConfig: "ciphertext",
      enabled: true,
      signingSecretConfigured: false,
      installationMethod: "manual",
      version: 1,
    });
    expect(explicit).toMatchObject({ enabled: false, signingSecretConfigured: true, version: 2 });
    expect(encrypted.map(({ value }) => value)).toEqual([
      JSON.stringify({ botToken: token }),
      JSON.stringify({ botToken: token, signingSecret: secret }),
    ]);
  });

  it("accepts complete and legacy event flags and both channel forms", () => {
    const { onHostOffline: _ignored, ...legacy } = DEFAULT_SLACK_NOTIFICATIONS;
    expect(validateSlackConfig({ ...input(), notifications: DEFAULT_SLACK_NOTIFICATIONS })).toEqual(
      {
        ok: true,
      },
    );
    expect(validateSlackConfig({ ...input(), notifications: legacy })).toEqual({ ok: true });
    expect(isSlackChannel("#valid_channel-9")).toBe(true);
    expect(isSlackChannel("C0123ABCDE")).toBe(true);
    expect(isSlackChannel("#Invalid")).toBe(false);
  });

  it("rejects malformed manual credential and notification payloads", () => {
    const completeWithBadValue = { ...DEFAULT_SLACK_NOTIFICATIONS, onSessionCreated: "yes" };
    for (const invalid of [
      { ...input(), botToken: "xoxp-user-token" },
      { ...input(), defaultChannel: "not a channel" },
      { ...input(), enabled: "false" },
      { ...input(), signingSecret: "short" },
      { ...input(), notifications: { ...DEFAULT_SLACK_NOTIFICATIONS, unknown: true } },
      { ...input(), notifications: completeWithBadValue },
    ]) {
      expect(validateSlackConfig(invalid as never)).toMatchObject({ ok: false });
    }
  });

  it("validates partial settings patches independently of credential replacement", () => {
    expect(
      validateSlackSettingsPatch({ expectedVersion: 1, defaultChannel: "C0123ABCDE" }),
    ).toEqual({ ok: true });
    expect(validateSlackSettingsPatch({ expectedVersion: 1, enabled: false })).toEqual({
      ok: true,
    });
    expect(
      validateSlackSettingsPatch({ expectedVersion: 1, notifications: { onHostOffline: false } }),
    ).toEqual({ ok: true });
    for (const invalid of [
      {},
      { expectedVersion: 1, defaultChannel: "#Invalid" },
      { expectedVersion: 1, enabled: "false" },
      { expectedVersion: 1, notifications: { unknown: true } },
      { expectedVersion: 1, notifications: { onHostOffline: "false" } },
    ]) {
      expect(validateSlackSettingsPatch(invalid as never)).toMatchObject({ ok: false });
    }
  });
});
