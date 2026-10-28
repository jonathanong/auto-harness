/* eslint-disable max-lines -- one scripted DynamoDB fake serves every backfill branch. */
import {
  DescribeTableCommand,
  ResourceInUseException,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { migrateSessionListIndexesPage } from "./ensure-session-list-backfill.ts";
import {
  ensureSessionListIndexes,
  sessionListIndexesActive,
} from "./ensure-session-list-indexes.ts";

const tables = { sessions: "Sessions", sessionDrains: "Drains" };

function conditional(): Error {
  return Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
}

function canceled(code: string): Error {
  return Object.assign(new Error("canceled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: code }],
  });
}

/** Scripted DynamoDB: the lease claim, the scan page, row writes, and the lease close-out. */
function script(options: {
  items: Array<Record<string, unknown>>;
  rowWrites?: Array<Error | undefined>;
  reread?: Array<Record<string, unknown> | undefined>;
  publish?: Error;
  published?: boolean;
}) {
  const writes: UpdateCommand["input"][] = [];
  const rereads = [...(options.reread ?? [])];
  const rowWrites = [...(options.rowWrites ?? [])];
  let drainGets = 0;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetCommand) {
      if (command.input.TableName === tables.sessionDrains) {
        drainGets += 1;
        // First call: not yet published. After a lost publish race: published by another.
        return drainGets > 1 && options.published
          ? { Item: { recordType: "session-list-indexes-v1" } }
          : {};
      }
      return { Item: rereads.shift() };
    }
    if (command instanceof ScanCommand) return { Items: options.items };
    if (command instanceof TransactWriteCommand) {
      if (options.publish) throw options.publish;
      return {};
    }
    if (command instanceof UpdateCommand) {
      if (command.input.TableName === tables.sessionDrains) {
        return { Attributes: { fence: 1 } };
      }
      writes.push(command.input);
      const failure = rowWrites.shift();
      if (failure) throw failure;
      return {};
    }
    throw new Error("unexpected command");
  });
  return { doc: { send } as never, writes };
}

const routed = { targetIndex: 0, commandId: "c", hostId: "h", attemptId: "att-1" };

describe("session list backfill row writes", () => {
  it("conditions each write on the route it observed", async () => {
    const { doc, writes } = script({
      items: [
        { id: "with-route", resolvedRoute: { ...routed, worktreeId: "wt-1" } },
        { id: "no-route" },
        { id: "no-attempt", resolvedRoute: { worktreeId: "wt-2" } },
        {
          id: "done",
          sessionList: "all",
          routeWorktreeId: "wt-3",
          resolvedRoute: { worktreeId: "wt-3" },
        },
      ],
    });
    await expect(migrateSessionListIndexesPage(doc, tables)).resolves.toBe(true);
    expect(writes.map((write) => write.ConditionExpression)).toEqual([
      "attribute_exists(id) AND resolvedRoute.attemptId = :attemptId",
      "attribute_exists(id) AND attribute_not_exists(resolvedRoute)",
      "attribute_exists(id) AND attribute_exists(resolvedRoute)",
    ]);
    expect(writes[0]!.UpdateExpression).toBe(
      "SET sessionList = :all, routeWorktreeId = :routeWorktreeId",
    );
    expect(writes[1]!.UpdateExpression).toBe("SET sessionList = :all REMOVE routeWorktreeId");
  });

  it("re-reads and recomputes when a concurrent assignment changes the route", async () => {
    const { doc, writes } = script({
      items: [{ id: "raced", resolvedRoute: { ...routed, worktreeId: "wt-old" } }],
      rowWrites: [conditional()],
      reread: [
        { id: "raced", resolvedRoute: { ...routed, attemptId: "att-2", worktreeId: "wt-new" } },
      ],
    });
    await expect(migrateSessionListIndexesPage(doc, tables)).resolves.toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.ExpressionAttributeValues).toMatchObject({
      ":routeWorktreeId": "wt-new",
      ":attemptId": "att-2",
    });
  });

  it("skips a row deleted mid-scan and gives up on one that keeps changing", async () => {
    const gone = script({
      items: [{ id: "gone" }],
      rowWrites: [conditional()],
      reread: [undefined],
    });
    await expect(migrateSessionListIndexesPage(gone.doc, tables)).resolves.toBe(true);
    expect(gone.writes).toHaveLength(1);

    const churn = script({
      items: [{ id: "churn" }],
      rowWrites: Array.from({ length: 5 }, conditional),
      reread: Array.from({ length: 5 }, () => ({ id: "churn" })),
    });
    await expect(migrateSessionListIndexesPage(churn.doc, tables)).resolves.toBe(true);
    expect(churn.writes).toHaveLength(5);
  });

  it("surfaces unexpected row write errors", async () => {
    const { doc } = script({ items: [{ id: "boom" }], rowWrites: [new Error("throttled")] });
    await expect(migrateSessionListIndexesPage(doc, tables)).rejects.toThrow("throttled");
  });
});

describe("session list backfill readiness publication", () => {
  it("accepts a marker published concurrently by another worker", async () => {
    const lost = script({
      items: [],
      publish: canceled("ConditionalCheckFailed"),
      published: true,
    });
    await expect(migrateSessionListIndexesPage(lost.doc, tables)).resolves.toBe(true);
    const notPublished = script({ items: [], publish: canceled("ConditionalCheckFailed") });
    await expect(migrateSessionListIndexesPage(notPublished.doc, tables)).resolves.toBe(false);
  });

  it("surfaces non-conditional publication and lease errors", async () => {
    const failing = script({ items: [], publish: canceled("ThrottlingError") });
    await expect(migrateSessionListIndexesPage(failing.doc, tables)).rejects.toThrow("canceled");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return {};
      throw new Error("lease unavailable");
    });
    await expect(migrateSessionListIndexesPage({ send } as never, tables)).rejects.toThrow(
      "lease unavailable",
    );
  });
});

const index = (name: string, status: string) => ({ IndexName: name, IndexStatus: status });

describe("ensureSessionListIndexes", () => {
  const names = [
    "repositoryId-createdOrder",
    "routeWorktreeId-createdOrder",
    "sessionList-createdOrder",
  ];

  it("reports active only when all three are ACTIVE", async () => {
    const active = {
      send: async () => ({
        Table: { GlobalSecondaryIndexes: names.map((n) => index(n, "ACTIVE")) },
      }),
    };
    await expect(sessionListIndexesActive(active as never, "t")).resolves.toBe(true);
    const building = {
      send: async () => ({ Table: { GlobalSecondaryIndexes: [index(names[0]!, "CREATING")] } }),
    };
    await expect(sessionListIndexesActive(building as never, "t")).resolves.toBe(false);
    await expect(sessionListIndexesActive({ send: async () => ({}) } as never, "t")).resolves.toBe(
      false,
    );
  });

  it("creates missing indexes one at a time, tolerating concurrent updates", async () => {
    const live: Array<ReturnType<typeof index>> = [];
    const creates: string[] = [];
    let concurrent = true;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          for (const item of live) item.IndexStatus = "ACTIVE";
          return {
            Table: {
              AttributeDefinitions: [{ AttributeName: "createdOrder" }],
              GlobalSecondaryIndexes: [...live],
            },
          };
        }
        const update = command as UpdateTableCommand;
        if (concurrent) {
          concurrent = false;
          throw new ResourceInUseException({ message: "busy", $metadata: {} });
        }
        const create = update.input.GlobalSecondaryIndexUpdates![0]!.Create!;
        creates.push(create.IndexName!);
        expect(update.input.AttributeDefinitions!.map((d) => d.AttributeName)).toContain(
          create.KeySchema![0]!.AttributeName,
        );
        live.push(index(create.IndexName!, "CREATING"));
        return {};
      },
    };
    await ensureSessionListIndexes(client as never, "t");
    expect(creates).toEqual(names);
  });

  it("returns quietly for a missing table and rethrows other failures", async () => {
    const missing = {
      send: async () => {
        throw new Error("ResourceNotFoundException");
      },
    };
    await expect(ensureSessionListIndexes(missing as never, "t")).resolves.toBeUndefined();
    const failing = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new Error("access denied");
      },
    };
    await expect(ensureSessionListIndexes(failing as never, "t")).rejects.toThrow("access denied");
  });
});
