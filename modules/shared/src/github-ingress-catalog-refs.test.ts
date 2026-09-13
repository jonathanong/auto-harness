import { describe, expect, it } from "vitest";

import {
  githubIngressCatalogReferenceKeys,
  githubIngressCatalogReferenceLimitError,
  MAX_GITHUB_INGRESS_CATALOG_REFS,
} from "./github-ingress-catalog-refs.ts";

describe("github ingress catalog references", () => {
  it("counts unique repositories, targets, and fallbacks", () => {
    expect(
      githubIngressCatalogReferenceKeys([
        {
          repositoryId: "repo-a",
          target: { commandId: "command-a" },
          fallbacks: [{ providerId: "provider-a" }],
        },
        {
          repositoryId: "repo-a",
          target: { commandId: "command-a" },
        },
      ]),
    ).toEqual(["repository:repo-a", "command:command-a", "provider:provider-a"]);
  });

  it("rejects an expanded unique count above the aggregate limit", () => {
    const keys = githubIngressCatalogReferenceKeys(
      Array.from({ length: 50 }, (_, index) => ({
        repositoryId: `repository-${index}`,
        target: { commandId: `command-${index}` },
      })),
    );
    expect(keys).toHaveLength(100);
    expect(githubIngressCatalogReferenceLimitError(keys.length)).toBe(
      `GitHub ingress configuration may reference at most ${MAX_GITHUB_INGRESS_CATALOG_REFS} unique catalog entries`,
    );
    expect(
      githubIngressCatalogReferenceLimitError(MAX_GITHUB_INGRESS_CATALOG_REFS),
    ).toBeUndefined();
  });
});
