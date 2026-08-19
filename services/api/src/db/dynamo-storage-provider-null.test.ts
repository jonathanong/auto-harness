import { describe, expect, it, vi } from "vitest";

import { putProviderAccount } from "./plane-storage-catalog-providers.ts";
import { tryAssignSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("DynamoDB NULL usageLimitedUntil", () => {
  it("omits null cooldown attributes on put so DynamoDB does not store NULL", async () => {
    const sent: Array<{ input?: Record<string, unknown> }> = [];
    const fakeCtx = {
      tables: { providerAccounts: "ProviderAccounts" },
      doc: {
        send: vi.fn(async (command: { input?: Record<string, unknown> }) => {
          sent.push(command);
          return {};
        }),
      },
    } as unknown as PlaneStorageCtx;

    await putProviderAccount(fakeCtx, {
      id: "acct-1",
      providerId: "prov-1",
      label: "a",
      usageLimitCooldownSeconds: 18000,
      createdAt: "t",
      updatedAt: "t",
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
    });
    const item = sent[0]?.input?.Item as Record<string, unknown>;
    expect(item).not.toHaveProperty("usageLimitedUntil");
    expect(item).not.toHaveProperty("lastUsageLimitedAt");
    expect(item).not.toHaveProperty("lastAssignedAt");
    expect(item.id).toBe("acct-1");
  });

  it("treats a stored NULL usageLimitedUntil as healthy when assigning", async () => {
    const sent: Array<{
      input?: {
        TransactItems?: Array<{
          Update?: {
            ConditionExpression?: string;
            ExpressionAttributeValues?: Record<string, unknown>;
          };
        }>;
      };
    }> = [];
    const fakeCtx = {
      tables: {
        sessions: "Sessions",
        worktrees: "Worktrees",
        hostLocks: "HostLocks",
        providerAccounts: "ProviderAccounts",
      },
      doc: {
        send: vi.fn(async (command: { input?: Record<string, unknown> }) => {
          sent.push(command);
          return {};
        }),
      },
    } as unknown as PlaneStorageCtx;

    expect(
      await tryAssignSession(fakeCtx, {
        sessionId: "sess-1",
        worktreeId: "wt-1",
        hostId: "host-1",
        connectionId: "conn-1",
        now: "2026-01-01T00:00:00.000Z",
        attemptId: "att-1",
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "cmd-1",
          hostId: "host-1",
          worktreeId: "wt-1",
          attemptId: "att-1",
        },
        providerAccountId: "acct-1",
        queueShard: 0,
      }),
    ).toBe(true);
    const accountUpdate = sent[0]?.input?.TransactItems?.find((item) =>
      item.Update?.ConditionExpression?.includes("usageLimitedUntil"),
    )?.Update;
    expect(accountUpdate?.ConditionExpression).toContain(
      "attribute_type(usageLimitedUntil, :nullType)",
    );
    expect(accountUpdate?.ExpressionAttributeValues?.[":nullType"]).toBe("NULL");
  });
});
