import type { TargetRef } from "@auto-harness/shared";

import type { CustomWebhookIntegrationRecord } from "./db/plane-storage-types.ts";

export function isValidCustomWebhookId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export type PublicCustomWebhookIntegration = Omit<
  CustomWebhookIntegrationRecord,
  "encryptedSecret"
> & { secretConfigured: true };

export type CustomWebhookConfigInput = {
  id: string;
  /** Omit on update to retain the existing encrypted secret. */
  secret?: string;
  repositoryId: string;
  target: TargetRef;
  fallbacks?: TargetRef[];
  queueTtlSeconds?: number;
  timeout: number;
  priority?: number;
  requiredLabels?: string[];
  enabled?: boolean;
};

export function customWebhookEncryptionContext(id: string): Record<string, string> {
  return { purpose: "auto-harness/custom-webhook", integrationId: id };
}

export function toPublicCustomWebhookIntegration(
  record: CustomWebhookIntegrationRecord,
): PublicCustomWebhookIntegration {
  const { encryptedSecret: _encryptedSecret, ...publicRecord } = record;
  return { ...publicRecord, secretConfigured: true };
}
