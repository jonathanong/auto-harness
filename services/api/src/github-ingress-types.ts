import { canonicalizeGitHubIngressDefaultRef, type TargetRef } from "@auto-harness/shared";

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
  /** Defaults to true on create. Omit on update to retain the current value. */
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
  const { encryptedSecret: _encryptedSecret, generation, ...publicRecord } = record;
  if (typeof generation !== "string" || generation.length === 0) {
    throw new TypeError("GitHub ingress generation is required");
  }
  return {
    ...publicRecord,
    generation,
    secretConfigured: true,
    bindings: publicRecord.bindings.map((binding) => ({
      ...binding,
      defaultRef: canonicalizeGitHubIngressDefaultRef(binding.defaultRef) ?? binding.defaultRef,
    })),
  };
}
