import { describe, expect, it, vi } from "vitest";

import { deadLetterWebhookDelivery } from "./plane-storage-webhook-settlement.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const conditional = Object.assign(new Error("lost"), {
  name: "ConditionalCheckFailedException",
});
const fence = {
  id: "delivery",
  owner: "owner",
  leaseId: "lease",
  now: "2026-01-01T00:00:00.000Z",
  failureCode: "delivery-rejected" as const,
};

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { webhookDeliveries: "Webhooks" } as never,
  } as PlaneStorageCtx;
}

describe("permanent webhook delivery settlement", () => {
  it("uses the live lease fence and preserves conditional failures", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(deadLetterWebhookDelivery(ctx(send), fence)).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      ConditionExpression:
        "#state = :leased AND leaseOwner = :owner AND leaseId = :leaseId AND leaseExpiresAt > :now",
      ExpressionAttributeValues: expect.objectContaining({
        ":failure": "delivery-rejected",
        ":leaseId": "lease",
      }),
    });
    await expect(
      deadLetterWebhookDelivery(ctx(vi.fn().mockRejectedValue(conditional)), fence),
    ).resolves.toBe(false);
    await expect(
      deadLetterWebhookDelivery(ctx(vi.fn().mockRejectedValue(new Error("unavailable"))), fence),
    ).rejects.toThrow("unavailable");
  });
});
