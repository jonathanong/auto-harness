import { describe, expect, it, vi } from "vitest";

import { releaseMainCheckoutSession } from "./plane-storage-main-checkout-release.ts";

describe("main-checkout deferred handoff condition", () => {
  it("requires an absent handoff before storing the first deferred handoff", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      releaseMainCheckoutSession(
        {
          doc: { send },
          tables: {
            sessions: "Sessions",
            hostLocks: "Hosts",
            concurrencyLocks: "Locks",
            sessionDrains: "Drains",
          },
        } as never,
        {
          sessionId: "session",
          hostId: "host",
          repositoryId: "repo",
          connectionId: "connection",
          attemptId: "attempt",
          status: "timed_out",
          expectedStatus: "timed_out",
          queueShard: 0,
          expectedTerminalHookHandoffAbsent: true,
        },
      ),
    ).resolves.toBe(true);
    const transaction = send.mock.calls
      .map(([command]) => command.input as { TransactItems?: Array<{ Update?: unknown }> })
      .find((input) => input.TransactItems !== undefined);
    const sessionUpdate = transaction?.TransactItems?.find(
      (item) => (item.Update as { TableName?: string } | undefined)?.TableName === "Sessions",
    )?.Update as { ConditionExpression?: string } | undefined;
    expect(sessionUpdate?.ConditionExpression).toContain(
      "attribute_not_exists(terminalHookHandoff)",
    );
  });
});
