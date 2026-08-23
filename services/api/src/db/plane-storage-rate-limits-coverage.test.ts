import { describe, expect, it, vi } from "vitest";

import { consumeRateLimit } from "./plane-storage-rate-limits.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const input = {
  actorKey: "actor",
  bucket: "mutation" as const,
  limit: 2,
  windowSeconds: 60,
  nowMs: 120_000,
};

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { rateLimits: "RateLimits" } as never,
  } as PlaneStorageCtx;
}

const conditional = Object.assign(new Error("lost"), {
  name: "ConditionalCheckFailedException",
});

describe("rate-limit storage branch coverage", () => {
  it("rejects requests older than the durable counter", async () => {
    await expect(
      consumeRateLimit(ctx(vi.fn().mockResolvedValue({ Item: { windowStartMs: 180_000 } })), input),
    ).resolves.toMatchObject({ allowed: false, resetAtMs: 240_000 });
  });

  it("increments legacy same-window counters and uses fallback returned counts", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { windowStartMs: 120_000 } })
      .mockResolvedValueOnce({});
    await expect(consumeRateLimit(ctx(send), input)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("retries conditional increment and reset races", async () => {
    const increment = vi
      .fn()
      .mockResolvedValueOnce({ Item: { windowStartMs: 120_000, count: 1 } })
      .mockRejectedValueOnce(conditional)
      .mockResolvedValueOnce({ Item: { windowStartMs: 120_000, count: 2 } });
    await expect(consumeRateLimit(ctx(increment), input)).resolves.toMatchObject({
      allowed: false,
    });

    const reset = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditional)
      .mockResolvedValueOnce({ Item: { windowStartMs: 60_000, count: 1 } })
      .mockResolvedValueOnce({});
    await expect(consumeRateLimit(ctx(reset), input)).resolves.toMatchObject({ allowed: true });
    expect(reset.mock.calls[3]?.[0].input.ExpressionAttributeValues).toMatchObject({
      ":oldWindowStart": 60_000,
    });
  });

  it("propagates non-conditional increment and reset failures", async () => {
    const failure = new Error("dynamo unavailable");
    await expect(
      consumeRateLimit(
        ctx(
          vi
            .fn()
            .mockResolvedValueOnce({ Item: { windowStartMs: 120_000, count: 1 } })
            .mockRejectedValueOnce(failure),
        ),
        input,
      ),
    ).rejects.toThrow("dynamo unavailable");
    await expect(
      consumeRateLimit(
        ctx(vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure)),
        input,
      ),
    ).rejects.toThrow("dynamo unavailable");
  });
});
