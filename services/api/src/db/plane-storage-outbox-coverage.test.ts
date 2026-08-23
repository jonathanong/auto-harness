import { describe, expect, it, vi } from "vitest";

import { claimDue, complete, enqueue } from "./plane-storage-notification-deliveries.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { listUsageRecords, putUsageRecord } from "./plane-storage-usage.ts";
import {
  claimWebhookDelivery,
  enqueueWebhookDelivery,
  listDueWebhookDeliveries,
} from "./plane-storage-webhook-outbox.ts";
import {
  completeWebhookDelivery,
  deadLetterExhaustedWebhookDelivery,
  failWebhookDelivery,
} from "./plane-storage-webhook-settlement.ts";

const conditional = Object.assign(new Error("lost"), {
  name: "ConditionalCheckFailedException",
});

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: {
      notificationDeliveries: "Notifications",
      webhookDeliveries: "Webhooks",
    } as never,
  } as PlaneStorageCtx;
}

describe("notification delivery storage branches", () => {
  it("maps duplicate enqueue and lost claim/update conditions", async () => {
    await expect(enqueue(ctx(vi.fn().mockRejectedValue(conditional)), {} as never)).resolves.toBe(
      "exists",
    );

    const noItems = vi.fn().mockResolvedValue({});
    await expect(
      claimDue(ctx(noItems), {
        now: "2026-01-01T00:00:00.000Z",
        leaseToken: "lease",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z",
      }),
    ).resolves.toBeNull();

    const noAttributes = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ id: "delivery" }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] });
    await expect(
      claimDue(ctx(noAttributes), {
        now: "2026-01-01T00:00:00.000Z",
        leaseToken: "lease",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z",
      }),
    ).resolves.toBeNull();

    const lostClaim = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ id: "delivery" }] })
      .mockRejectedValueOnce(conditional)
      .mockResolvedValueOnce({ Items: [] });
    await expect(
      claimDue(ctx(lostClaim), {
        now: "2026-01-01T00:00:00.000Z",
        leaseToken: "lease",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z",
      }),
    ).resolves.toBeNull();

    await expect(
      complete(ctx(vi.fn().mockRejectedValue(conditional)), {
        id: "delivery",
        leaseToken: "lease",
        now: "2026-01-01T00:00:00.000Z",
        result: { channel: "C12345678", messageTs: "1.2" },
      }),
    ).resolves.toBe(false);
  });

  it("propagates non-conditional notification storage failures", async () => {
    const failure = new Error("dynamo unavailable");
    await expect(enqueue(ctx(vi.fn().mockRejectedValue(failure)), {} as never)).rejects.toBe(
      failure,
    );
    await expect(
      claimDue(
        ctx(
          vi
            .fn()
            .mockResolvedValueOnce({ Items: [{ id: "delivery" }] })
            .mockRejectedValueOnce(failure),
        ),
        {
          now: "2026-01-01T00:00:00.000Z",
          leaseToken: "lease",
          leaseExpiresAt: "2026-01-01T00:01:00.000Z",
        },
      ),
    ).rejects.toBe(failure);
    await expect(
      complete(ctx(vi.fn().mockRejectedValue(failure)), {
        id: "delivery",
        leaseToken: "lease",
        now: "2026-01-01T00:00:00.000Z",
        result: { channel: "C12345678", messageTs: "1.2" },
      }),
    ).rejects.toBe(failure);
  });
});

describe("webhook delivery storage branches", () => {
  const webhookInput = {
    sessionId: "session",
    repositoryId: "repo",
    attemptId: null,
    status: "completed" as const,
    occurredAt: "2026-01-01T00:00:00.000Z",
    destination: { configurationId: "config", configurationVersion: 1 },
  };
  const lease = {
    id: "delivery",
    owner: "owner",
    leaseId: "lease",
    now: "2026-01-01T00:00:00.000Z",
    leaseExpiresAt: "2026-01-01T00:01:00.000Z",
  };

  it("validates empty fences and maps absent query and claim results", async () => {
    await expect(claimWebhookDelivery(ctx(vi.fn()), { ...lease, owner: " " })).rejects.toThrow(
      "owner must not be empty",
    );
    await expect(
      listDueWebhookDeliveries(ctx(vi.fn().mockResolvedValue({})), {
        state: "pending",
        now: lease.now,
        limit: 1,
      }),
    ).resolves.toEqual([]);
    await expect(
      claimWebhookDelivery(ctx(vi.fn().mockResolvedValue({})), lease),
    ).resolves.toBeNull();
    await expect(
      claimWebhookDelivery(ctx(vi.fn().mockRejectedValue(conditional)), lease),
    ).resolves.toBeNull();
  });

  it("rethrows a duplicate enqueue when the conditional winner cannot be read", async () => {
    const send = vi.fn().mockRejectedValueOnce(conditional).mockResolvedValueOnce({});
    await expect(enqueueWebhookDelivery(ctx(send), webhookInput)).rejects.toBe(conditional);
  });

  it("validates settlement fences and propagates non-conditional failures", async () => {
    const failure = new Error("dynamo unavailable");
    await expect(completeWebhookDelivery(ctx(vi.fn()), { ...lease, id: " " })).rejects.toThrow(
      "id must not be empty",
    );
    await expect(
      completeWebhookDelivery(ctx(vi.fn().mockRejectedValue(failure)), lease),
    ).rejects.toBe(failure);
    await expect(
      failWebhookDelivery(ctx(vi.fn().mockRejectedValue(failure)), {
        ...lease,
        failureCode: "unknown",
        nextAttemptAt: "2026-01-01T00:02:00.000Z",
      }),
    ).rejects.toBe(failure);
    await expect(
      deadLetterExhaustedWebhookDelivery(ctx(vi.fn().mockRejectedValue(failure)), {
        id: "delivery",
        now: lease.now,
      }),
    ).rejects.toBe(failure);
  });
});

describe("usage storage branches", () => {
  it("maps transaction cancellation and defaults missing query and scan pages", async () => {
    const transactionCancelled = Object.assign(new Error("cancelled"), {
      name: "TransactionCanceledException",
    });
    await expect(
      putUsageRecord(
        ctx(vi.fn().mockRejectedValue(transactionCancelled)),
        {
          sessionId: "session",
          repositoryId: "repo",
          attemptId: "attempt",
          worktreeId: "worktree",
          kind: "delta",
          sequence: 1,
          source: "cli",
          observedAt: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
        { hostId: "host", connectionId: "connection" },
      ),
    ).resolves.toBe(false);
    await expect(listUsageRecords(ctx(vi.fn().mockResolvedValue({})), "session")).resolves.toEqual(
      [],
    );
    const scan = vi
      .fn()
      .mockResolvedValueOnce({ LastEvaluatedKey: { sessionId: "session" } })
      .mockResolvedValueOnce({ Items: [{ sessionId: "session" }] });
    await expect(listUsageRecords(ctx(scan))).resolves.toEqual([{ sessionId: "session" }]);
    expect(scan.mock.calls[1]?.[0].input.ExclusiveStartKey).toEqual({ sessionId: "session" });
  });
});
