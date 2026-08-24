import { describe, expect, it } from "vitest";

import { clearAll } from "./plane-storage-clear.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("clearAll session-drain cleanup", () => {
  it("removes drain and ACT rows while preserving the activity-ledger readiness marker", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          commands.push(command);
          if (
            command.input.TableName === "session-drains" &&
            "ExclusiveStartKey" in command.input
          ) {
            return {
              Items: [
                { scopeKey: "__session-drain-ledger__", recordKey: "ACTIVITY-V1" },
                { scopeKey: "repo#principal", recordKey: "CURRENT" },
                { scopeKey: "repo#principal", recordKey: "ACT#session" },
              ],
            };
          }
          return {};
        },
      },
      tables: {
        sessionDrains: "session-drains",
        notificationDeliveries: "notifications",
        authAccounts: "auth-accounts",
        sessions: "sessions",
        worktrees: "worktrees",
        connections: "connections",
        hostLocks: "host-locks",
        rateLimits: "rate-limits",
        viewerTickets: "viewer-tickets",
        concurrencyLocks: "concurrency-locks",
        schedules: "schedules",
        repositories: "repositories",
        archives: "archives",
        hostInventories: "host-inventories",
        providers: "providers",
        providerAccounts: "provider-accounts",
        commands: "commands",
        auditLogs: "audit-logs",
        integrations: "integrations",
        webhookDeliveries: "webhooks",
        sessionLogs: "session-logs",
      },
    } as unknown as PlaneStorageCtx;

    await clearAll(ctx);

    const deletes = commands
      .map((command) => command.input)
      .filter((input) => input.TableName === "session-drains" && "Key" in input)
      .map((input) => input.Key);
    expect(deletes).toEqual([
      { scopeKey: "repo#principal", recordKey: "CURRENT" },
      { scopeKey: "repo#principal", recordKey: "ACT#session" },
    ]);
  });
});
