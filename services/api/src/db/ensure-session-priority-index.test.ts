import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

import {
  ensureSessionsPriorityIndexes,
  SESSIONS_CREATED_ORDER_INDEX,
  SESSIONS_PRIORITY_ORDER_INDEX,
  SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
} from "./ensure-session-priority-index.ts";

function activeIndexes(names: string[]) {
  return {
    Table: {
      GlobalSecondaryIndexes: names.map((IndexName) => ({ IndexName, IndexStatus: "ACTIVE" })),
    },
  };
}

describe("ensureSessionsPriorityIndexes", () => {
  it("creates one index at a time and waits for each to be ACTIVE", async () => {
    const commands: unknown[] = [];
    const active = new Set<string>();
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof UpdateTableCommand) {
        const created = command.input.GlobalSecondaryIndexUpdates?.[0]?.Create?.IndexName;
        if (created) active.add(created);
        return {};
      }
      if (!(command instanceof DescribeTableCommand)) throw new Error("unexpected command");
      return {
        Table: {
          AttributeDefinitions: [],
          GlobalSecondaryIndexes: [...active].map((IndexName) => ({
            IndexName,
            IndexStatus: "ACTIVE",
          })),
        },
      };
    });

    await ensureSessionsPriorityIndexes({ send } as never, "Sessions");

    const updates = commands.filter((command) => command instanceof UpdateTableCommand);
    expect(updates).toHaveLength(3);
    expect((updates[0] as UpdateTableCommand).input.GlobalSecondaryIndexUpdates).toMatchObject([
      { Create: { IndexName: SESSIONS_CREATED_ORDER_INDEX } },
    ]);
    expect((updates[1] as UpdateTableCommand).input.GlobalSecondaryIndexUpdates).toMatchObject([
      { Create: { IndexName: SESSIONS_PRIORITY_ORDER_INDEX } },
    ]);
    expect((updates[2] as UpdateTableCommand).input.GlobalSecondaryIndexUpdates).toMatchObject([
      { Create: { IndexName: SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX } },
    ]);
  });

  it("does not modify a table which cannot yet be described", async () => {
    await expect(
      ensureSessionsPriorityIndexes(
        { send: vi.fn().mockRejectedValue(new Error("offline")) } as never,
        "Sessions",
      ),
    ).resolves.toBeUndefined();
  });

  it("retries concurrent index updates and rejects unexpected update failures", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Table: {} })
      .mockRejectedValueOnce({ name: "ResourceInUseException" })
      .mockResolvedValueOnce(activeIndexes([SESSIONS_PRIORITY_ORDER_INDEX]))
      .mockResolvedValueOnce(activeIndexes([SESSIONS_PRIORITY_ORDER_INDEX]))
      .mockRejectedValueOnce({ name: "LimitExceededException" })
      .mockResolvedValueOnce(
        activeIndexes([SESSIONS_PRIORITY_ORDER_INDEX, SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX]),
      );

    await expect(ensureSessionsPriorityIndexes({ send } as never, "Sessions")).resolves.toBe(
      undefined,
    );

    const failed = vi
      .fn()
      .mockResolvedValueOnce({ Table: {} })
      .mockRejectedValueOnce(new Error("update failed"));
    await expect(
      ensureSessionsPriorityIndexes({ send: failed } as never, "Sessions"),
    ).rejects.toThrow("update failed");
  });

  it("fails after a bounded wait for an index stuck creating", async () => {
    const send = vi.fn().mockResolvedValue({
      Table: {
        GlobalSecondaryIndexes: [
          { IndexName: SESSIONS_CREATED_ORDER_INDEX, IndexStatus: "CREATING" },
        ],
      },
    });

    await expect(ensureSessionsPriorityIndexes({ send } as never, "Sessions")).rejects.toThrow(
      `timed out waiting for ${SESSIONS_CREATED_ORDER_INDEX} to become ACTIVE`,
    );
    expect(send).toHaveBeenCalledTimes(300);
  });
});
