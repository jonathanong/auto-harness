import { describe, expect, it } from "vitest";

import type { GitHubIngressConfigRecord } from "./db/plane-storage-types.ts";
import { toPublicGitHubIngressConfig } from "./github-ingress-types.ts";

const record: GitHubIngressConfigRecord = {
  id: "github-ingress",
  type: "github-ingress",
  encryptedSecret: "cipher",
  enabled: true,
  bindings: [
    {
      githubRepositoryId: 1,
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      defaultRef: "main",
      allowedLogins: [],
    },
  ],
  generation: "11111111-1111-4111-8111-111111111111",
  version: 1,
  createdAt: "now",
  updatedAt: "now",
};

describe("toPublicGitHubIngressConfig", () => {
  it("strips the encrypted secret and reports it as configured", () => {
    const result = toPublicGitHubIngressConfig(record);
    expect(result).toMatchObject({
      generation: "11111111-1111-4111-8111-111111111111",
      secretConfigured: true,
    });
    expect(result).not.toHaveProperty("encryptedSecret");
  });

  it("rejects a record with no generation stamped, rather than defaulting to legacy", () => {
    const { generation: _generation, ...withoutGeneration } = record;
    expect(() =>
      toPublicGitHubIngressConfig(withoutGeneration as GitHubIngressConfigRecord),
    ).toThrow("GitHub ingress generation is required");
  });

  it("rejects a record with an empty-string generation", () => {
    expect(() => toPublicGitHubIngressConfig({ ...record, generation: "" })).toThrow(
      "GitHub ingress generation is required",
    );
  });
});
