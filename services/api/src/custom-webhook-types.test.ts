import { describe, expect, it } from "vitest";

import type { CustomWebhookIntegrationRecord } from "./db/plane-storage-types.ts";
import { toPublicCustomWebhookIntegration } from "./custom-webhook-types.ts";

const record: CustomWebhookIntegrationRecord = {
  id: "deploy",
  type: "custom-webhook",
  encryptedSecret: "cipher",
  repositoryId: "repo",
  target: { providerId: "provider" },
  fallbacks: [],
  queueTtlSeconds: 60,
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  enabled: true,
  version: 1,
  generation: "11111111-1111-4111-8111-111111111111",
  createdAt: "now",
  updatedAt: "now",
};

describe("toPublicCustomWebhookIntegration", () => {
  it("strips the encrypted secret and reports it as configured", () => {
    expect(toPublicCustomWebhookIntegration(record)).toMatchObject({
      id: "deploy",
      generation: "11111111-1111-4111-8111-111111111111",
      secretConfigured: true,
    });
    expect(toPublicCustomWebhookIntegration(record)).not.toHaveProperty("encryptedSecret");
  });

  it("rejects a record with no generation stamped, rather than defaulting to legacy", () => {
    const { generation: _generation, ...withoutGeneration } = record;
    expect(() =>
      toPublicCustomWebhookIntegration(withoutGeneration as CustomWebhookIntegrationRecord),
    ).toThrow("custom webhook generation is required");
  });

  it("rejects a record with an empty-string generation", () => {
    expect(() => toPublicCustomWebhookIntegration({ ...record, generation: "" })).toThrow(
      "custom webhook generation is required",
    );
  });
});
