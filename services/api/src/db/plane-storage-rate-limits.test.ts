import { describe, expect, it } from "vitest";

import { createDynamoClients, tableNames } from "./dynamo.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";

const dynamo = createDynamoTestCtx("RateLimits");

describe("durable rate limits", () => {
  it("enforces one shared atomic budget across concurrent workers", async () => {
    if (!dynamo.available || !dynamo.storage) return;
    const { doc } = createDynamoClients();
    const second = new DynamoPlaneStorage(doc, tableNames(dynamo.prefix));
    const input = {
      actorKey: "service-account:ci",
      bucket: "mutation" as const,
      limit: 3,
      windowSeconds: 60,
      nowMs: 120_000,
    };
    const decisions = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? dynamo.storage : second).consumeRateLimit(input),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(7);
    expect((await second.consumeRateLimit({ ...input, nowMs: 180_000 })).allowed).toBe(true);
  });
});
