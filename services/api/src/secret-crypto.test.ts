import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredSecretEncryptor,
  KmsSecretEncryptor,
  SLACK_SECRET_ENCRYPTION_CONTEXT,
} from "./secret-crypto.ts";

afterEach(() => vi.unstubAllEnvs());

describe("KMS integration secrets", () => {
  it("requires a key and sends its stable encryption context on encryption and decryption", async () => {
    vi.stubEnv("KMS_KEY_ID", "");
    expect(() => new KmsSecretEncryptor()).toThrow("KMS_KEY_ID");
    let calls = 0;
    const client = {
      send: async () =>
        ++calls === 1
          ? { CiphertextBlob: Buffer.from("ciphertext") }
          : { Plaintext: Buffer.from("plaintext") },
    };
    const crypto = new KmsSecretEncryptor({ keyId: "key", client: client as never });
    expect(await crypto.encrypt("plaintext", SLACK_SECRET_ENCRYPTION_CONTEXT)).toBe(
      Buffer.from("ciphertext").toString("base64"),
    );
    expect(
      await crypto.decrypt(
        Buffer.from("ciphertext").toString("base64"),
        SLACK_SECRET_ENCRYPTION_CONTEXT,
      ),
    ).toBe("plaintext");
  });

  it("rejects incomplete KMS responses and is enabled only by KMS_KEY_ID", async () => {
    const crypto = new KmsSecretEncryptor({
      keyId: "key",
      client: { send: async () => ({}) } as never,
    });
    await expect(crypto.encrypt("x", {})).rejects.toThrow("ciphertext");
    await expect(crypto.decrypt("eA==", {})).rejects.toThrow("plaintext");
    vi.stubEnv("KMS_KEY_ID", "");
    expect(configuredSecretEncryptor()).toBeUndefined();
    vi.stubEnv("KMS_KEY_ID", "key");
    expect(configuredSecretEncryptor()).toBeInstanceOf(KmsSecretEncryptor);
  });
});
