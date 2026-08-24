import { describe, expect, it } from "vitest";

import { providerAccountLastAssignedTransactItem } from "./plane-storage-provider-account-assignment.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const ctx = { tables: { providerAccounts: "ProviderAccounts" } } as PlaneStorageCtx;

describe("provider account assignment fence", () => {
  it("fences last-assigned updates against the selected slot", () => {
    const fenced = providerAccountLastAssignedTransactItem(ctx, {
      providerAccountId: "acct",
      now: "now",
      slot: 2,
    });
    expect(fenced.Update.ConditionExpression).toContain("maxConcurrentSessions > :slot");
    expect(fenced.Update.ExpressionAttributeValues[":slot"]).toBe(2);
    expect(
      providerAccountLastAssignedTransactItem(ctx, { providerAccountId: "acct", now: "now" }).Update
        .ConditionExpression,
    ).not.toContain(":slot");
  });

  it("fences the account against a catalog move", () => {
    const fenced = providerAccountLastAssignedTransactItem(ctx, {
      providerAccountId: "acct",
      providerId: "provider-one",
      now: "now",
    });
    expect(fenced.Update.ConditionExpression).toContain("providerId = :providerId");
    expect(fenced.Update.ExpressionAttributeValues[":providerId"]).toBe("provider-one");
  });
});
