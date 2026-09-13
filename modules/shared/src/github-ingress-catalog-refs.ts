import type { TargetRef } from "./session.ts";

/** One write plus at most 99 marker condition checks fits DynamoDB's 100-action limit. */
export const MAX_GITHUB_INGRESS_CATALOG_REFS = 99;

export type GitHubIngressCatalogBinding = {
  repositoryId: string;
  target: TargetRef;
  fallbacks?: readonly TargetRef[];
};

/** Unique catalog keys fenced when persisting a GitHub ingress configuration. */
export function githubIngressCatalogReferenceKeys(
  bindings: readonly GitHubIngressCatalogBinding[],
): string[] {
  const keys = new Set<string>();
  for (const binding of bindings) {
    keys.add(`repository:${binding.repositoryId}`);
    for (const route of [binding.target, ...(binding.fallbacks ?? [])]) {
      keys.add(
        "providerId" in route ? `provider:${route.providerId}` : `command:${route.commandId}`,
      );
    }
  }
  return [...keys];
}

export function githubIngressCatalogReferenceLimitError(count: number): string | undefined {
  if (count <= MAX_GITHUB_INGRESS_CATALOG_REFS) return undefined;
  return `GitHub ingress configuration may reference at most ${MAX_GITHUB_INGRESS_CATALOG_REFS} unique catalog entries`;
}
