import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/** Small boundary so all secret-bearing code is explicit and easily faked in tests. */
export type SecretEncryptor = {
  encrypt(plaintext: string, context: Record<string, string>): Promise<string>;
  decrypt(ciphertext: string, context: Record<string, string>): Promise<string>;
};

export const SLACK_SECRET_ENCRYPTION_CONTEXT = {
  purpose: "auto-harness/slack-integration",
  integrationId: "slack",
} as const;

/** KMS only: Slack credentials are never accepted with a plaintext fallback. */
export class KmsSecretEncryptor implements SecretEncryptor {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(options: { keyId?: string; client?: KMSClient } = {}) {
    this.keyId = options.keyId ?? process.env.KMS_KEY_ID ?? "";
    if (!this.keyId) throw new Error("KMS_KEY_ID is required for integration secrets");
    this.client = options.client ?? new KMSClient({});
  }

  async encrypt(plaintext: string, context: Record<string, string>): Promise<string> {
    const response = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, "utf8"),
        EncryptionContext: context,
      }),
    );
    if (!response.CiphertextBlob) throw new Error("KMS did not return ciphertext");
    return Buffer.from(response.CiphertextBlob).toString("base64");
  }

  async decrypt(ciphertext: string, context: Record<string, string>): Promise<string> {
    const response = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, "base64"),
        EncryptionContext: context,
      }),
    );
    if (!response.Plaintext) throw new Error("KMS did not return plaintext");
    return Buffer.from(response.Plaintext).toString("utf8");
  }
}

/** Missing KMS configuration makes configuration writes fail closed. */
export function configuredSecretEncryptor(): SecretEncryptor | undefined {
  return process.env.KMS_KEY_ID ? new KmsSecretEncryptor() : undefined;
}
