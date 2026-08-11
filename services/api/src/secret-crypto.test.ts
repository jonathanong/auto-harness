import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredSecretEncryptor,
  KmsSecretEncryptor,
  SLACK_SECRET_ENCRYPTION_CONTEXT,
} from "./secret-crypto.ts";

const context = { ...SLACK_SECRET_ENCRYPTION_CONTEXT };

afterEach(() => vi.unstubAllEnvs());

describe("KMS integration secret encryption", () => {
  it("requires a key and carries the stable encryption context through encrypt/decrypt", async () => {
    vi.stubEnv("KMS_KEY_ID", "");
    expect(() => new KmsSecretEncryptor()).toThrow("KMS_KEY_ID");

    const sent: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        return sent.length === 1
          ? { CiphertextBlob: Buffer.from("ciphertext") }
          : { Plaintext: Buffer.from("plaintext") };
      },
    };
    const encryptor = new KmsSecretEncryptor({ keyId: "key-1", client: client as never });
    expect(await encryptor.encrypt("plaintext", context)).toBe(
      Buffer.from("ciphertext").toString("base64"),
    );
    expect(await encryptor.decrypt(Buffer.from("ciphertext").toString("base64"), context)).toBe(
      "plaintext",
    );
    expect(sent).toHaveLength(2);
  });

  it("rejects incomplete KMS responses and configures only when an environment key exists", async () => {
    const empty = { send: async () => ({}) };
    const encryptor = new KmsSecretEncryptor({ keyId: "key-1", client: empty as never });
    await expect(encryptor.encrypt("x", context)).rejects.toThrow("ciphertext");
    await expect(encryptor.decrypt("eA==", context)).rejects.toThrow("plaintext");

    vi.stubEnv("KMS_KEY_ID", "");
    expect(configuredSecretEncryptor()).toBeUndefined();
    vi.stubEnv("KMS_KEY_ID", "key-from-env");
    expect(configuredSecretEncryptor()).toBeInstanceOf(KmsSecretEncryptor);
  });
});
