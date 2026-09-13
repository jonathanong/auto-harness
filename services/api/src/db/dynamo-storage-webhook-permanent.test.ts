import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("WebhookPermanent");
const now = "2026-08-12T20:00:00.000Z";

describe("DynamoDB permanent webhook delivery settlement", () => {
  it("dead-letters a rejected delivery only for its exact live lease", async () => {
    if (!ctx.storage) return;
    const { delivery } = await ctx.storage.enqueueWebhookDelivery({
      sessionId: "session",
      repositoryId: "repository",
      attemptId: "attempt",
      status: "completed",
      occurredAt: now,
      destination: { configurationId: "operations", configurationVersion: 1 },
      maxAttempts: 2,
    });
    const fence = { id: delivery.id, owner: "worker", leaseId: "lease", now };
    await ctx.storage.claimWebhookDelivery({
      ...fence,
      leaseExpiresAt: "2026-08-12T20:01:00.000Z",
    });
    await expect(
      ctx.storage.deadLetterWebhookDelivery({
        ...fence,
        leaseId: "stale",
        failureCode: "delivery-rejected",
      }),
    ).resolves.toBe(false);
    await expect(
      ctx.storage.deadLetterWebhookDelivery({ ...fence, failureCode: "delivery-rejected" }),
    ).resolves.toBe(true);
    await expect(ctx.storage.getWebhookDelivery(delivery.id)).resolves.toMatchObject({
      state: "dead",
      attemptCount: 1,
      lastFailureCode: "delivery-rejected",
    });
  });
});
