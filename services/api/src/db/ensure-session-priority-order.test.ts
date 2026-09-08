/* eslint-disable max-lines -- migration races share one ordered Dynamo command harness. */
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import {
  createdOrderKey,
  priorityOrderKey,
  repositoryPriorityOrderKey,
} from "../control-plane-ordering.ts";
import {
  migrateSessionPriorityOrderPage,
  SESSION_PRIORITY_ORDER_READY_RECORD_KEY,
  SESSION_PRIORITY_ORDER_SCOPE_KEY,
} from "./ensure-session-priority-order.ts";

const tables = { sessions: "Sessions", sessionDrains: "SessionDrains" };

describe("migrateSessionPriorityOrderPage", () => {
  it("is already ready without claiming a lease", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { recordType: "session-priority-order-v2" } });

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });

  it("supersedes the v1 readiness marker so createdOrder is backfilled", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { recordType: "session-priority-order-v1" } })
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(true);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: expect.objectContaining({
        Key: { scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY, recordKey: "MIGRATION-V2" },
      }),
    });
  });

  it("repairs a bounded page then checkpoints its opaque scan key", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 3 } })
      .mockResolvedValueOnce({
        Items: [
          {
            id: "session-1",
            repositoryId: "repo-1",
            priority: 4,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        LastEvaluatedKey: { id: "session-2" },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(false);

    const commands = send.mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      expect.any(GetCommand),
      expect.any(UpdateCommand),
      expect.any(ScanCommand),
      expect.any(UpdateCommand),
      expect.any(UpdateCommand),
    ]);
    expect((commands[2] as ScanCommand).input).toMatchObject({
      ConsistentRead: true,
      Limit: 100,
      TableName: "Sessions",
    });
    expect((commands[3] as UpdateCommand).input.ExpressionAttributeValues).toMatchObject({
      ":createdOrder": "2026-01-01T00:00:00.000Z#session-1",
      ":priorityOrder": "10004#2026-01-01T00:00:00.000Z#session-1",
    });
    expect((commands[4] as UpdateCommand).input).toMatchObject({
      Key: { scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY, recordKey: "MIGRATION-V2" },
    });
  });

  it("publishes READY atomically after the final page", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 2 } })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(true);

    const command = send.mock.calls[3]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect((command as TransactWriteCommand).input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY,
              recordKey: SESSION_PRIORITY_ORDER_READY_RECORD_KEY,
              recordType: "session-priority-order-v2",
            }),
          }),
        }),
      ]),
    );
  });

  it("repairs stale keys instead of treating their presence as readiness", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({
        Items: [
          {
            id: "session-stale",
            repositoryId: "repo-1",
            priority: 4,
            createdAt: "2026-01-01T00:00:00.000Z",
            priorityOrder: "stale",
            repositoryPriorityOrder: "stale",
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(true);

    const repair = send.mock.calls[3]?.[0];
    expect(repair).toBeInstanceOf(UpdateCommand);
    expect((repair as UpdateCommand).input.ConditionExpression).toContain(
      "priorityOrder <> :priorityOrder",
    );
  });

  it("fails closed instead of publishing READY for a malformed session", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({ Items: [{ id: "bad", repositoryId: "repo", priority: 0.5 }] });

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).rejects.toThrow(
      "cannot migrate malformed session bad",
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not rewrite a row whose exact keys are already present", async () => {
    const session = {
      id: "session-ready",
      priority: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const item = {
      ...session,
      repositoryId: "repo-1",
      createdOrder: createdOrderKey(session),
      priorityOrder: priorityOrderKey(session),
      repositoryPriorityOrder: repositoryPriorityOrderKey("repo-1", session),
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({ Items: [item] })
      .mockResolvedValueOnce({});

    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(true);
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      expect.any(GetCommand),
      expect.any(UpdateCommand),
      expect.any(ScanCommand),
      expect.any(TransactWriteCommand),
    ]);
  });

  it("tolerates a concurrently repaired row but propagates other repair failures", async () => {
    const item = {
      id: "session-race",
      repositoryId: "repo-1",
      priority: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const raced = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({ Items: [item] })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
      .mockResolvedValueOnce({});
    await expect(migrateSessionPriorityOrderPage({ send: raced } as never, tables)).resolves.toBe(
      true,
    );

    const failed = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({ Items: [item] })
      .mockRejectedValueOnce(new Error("repair failed"));
    await expect(
      migrateSessionPriorityOrderPage({ send: failed } as never, tables),
    ).rejects.toThrow("repair failed");
  });

  it("returns for a busy migration lease and propagates lease read failures", async () => {
    const busy = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    await expect(migrateSessionPriorityOrderPage({ send: busy } as never, tables)).resolves.toBe(
      false,
    );

    const failed = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("lease failed"));
    await expect(
      migrateSessionPriorityOrderPage({ send: failed } as never, tables),
    ).rejects.toThrow("lease failed");
  });

  it("rechecks READY after a conditional final transaction race", async () => {
    for (const ready of [true, false]) {
      const send = vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Attributes: { fence: 1 } })
        .mockResolvedValueOnce({ Items: [] })
        .mockRejectedValueOnce({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        })
        .mockResolvedValueOnce({
          Item: ready ? { recordType: "session-priority-order-v2" } : undefined,
        });
      await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).resolves.toBe(ready);
    }
  });

  it("propagates a non-conditional final transaction failure", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { fence: 1 } })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(new Error("publish failed"));
    await expect(migrateSessionPriorityOrderPage({ send } as never, tables)).rejects.toThrow(
      "publish failed",
    );
  });
});
