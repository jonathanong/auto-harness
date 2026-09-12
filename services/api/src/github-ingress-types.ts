import type { TargetRef } from "@auto-harness/shared";

import type { GitHubIngressConfigRecord } from "./db/plane-storage-types.ts";

type GitHubIngressBindingInput = {
  githubRepositoryId: number;
  repositoryId: string;
  target: TargetRef;
  fallbacks?: TargetRef[];
  queueTtlSeconds?: number;
  timeout: number;
  priority?: number;
  requiredLabels?: string[];
  defaultRef: string;
  allowedLogins?: string[];
};

export type GitHubIngressConfigInput = {
  /** Omit only on update to retain the encrypted webhook secret. */
  secret?: string;
  enabled?: boolean;
  bindings: GitHubIngressBindingInput[];
};

export type PublicGitHubIngressConfig = Omit<GitHubIngressConfigRecord, "encryptedSecret"> & {
  secretConfigured: true;
};

export function githubIngressEncryptionContext(): Record<string, string> {
  return { purpose: "auto-harness/github-ingress", integrationId: "github-ingress" };
}

export function toPublicGitHubIngressConfig(
  record: GitHubIngressConfigRecord,
): PublicGitHubIngressConfig {
  const { encryptedSecret: _encryptedSecret, ...publicRecord } = record;
  return { ...publicRecord, secretConfigured: true };
}
