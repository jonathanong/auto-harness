import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  nextPageKey,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import type { WorktreeRecord } from "./types.ts";

export async function putWorktree(ctx: PlaneStorageCtx, wt: WorktreeRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.worktrees,
      Item: { ...wt },
    }),
  );
}

export async function deleteWorktree(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.worktrees, Key: { id } }));
}

/** Registration inventory is written only while its exact host lease is
 * current. This prevents an old API process from publishing stale inventory
 * after a replacement connection has won the host lock. */
export async function putWorktreeFenced(
  ctx: PlaneStorageCtx,
  wt: WorktreeRecord,
  fence: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: fence.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": fence.connectionId },
            },
          },
          {
            Put: {
              TableName: ctx.tables.worktrees,
              Item: { ...wt },
              // A registration inventory snapshot must never overwrite an
              // assigned worktree. Reconciliation owns that transition.
              ConditionExpression: "attribute_not_exists(id) OR #s <> :busy",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":busy": "busy" },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

export async function getWorktree(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<WorktreeRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.worktrees, Key: { id } }));
  return (res.Item as WorktreeRecord | undefined) ?? null;
}

export async function listAllWorktrees(
  ctx: PlaneStorageCtx,
  consistentRead = false,
): Promise<WorktreeRecord[]> {
  const items: WorktreeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ...(consistentRead ? { ConsistentRead: true } : {}),
        TableName: ctx.tables.worktrees,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as WorktreeRecord[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return items;
}

export async function listWorktreesForRepo(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  consistentRead = false,
): Promise<WorktreeRecord[]> {
  // The repository GSI is eventually consistent. Drain completion must not infer that a
  // lease is gone from a stale index, so use an authoritative base-table scan when requested.
  if (consistentRead) {
    return (await listAllWorktrees(ctx, true)).filter(
      (worktree) => worktree.repositoryId === repositoryId,
    );
  }
  const records: WorktreeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.worktrees,
        IndexName: "repositoryId-id",
        KeyConditionExpression: "repositoryId = :r",
        ExpressionAttributeValues: { ":r": repositoryId },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as WorktreeRecord[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

/** Conditional claim (Invariant 1): idle + online → busy. */
export async function tryClaimWorktree(
  ctx: PlaneStorageCtx,
  opts: { worktreeId: string; sessionId: string; now: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.worktrees,
        Key: { id: opts.worktreeId },
        UpdateExpression: "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now",
        ConditionExpression: "#s = :idle AND #o = :true",
        ExpressionAttributeNames: { "#s": "status", "#o": "online" },
        ExpressionAttributeValues: {
          ":busy": "busy",
          ":idle": "idle",
          ":true": true,
          ":sid": opts.sessionId,
          ":now": opts.now,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) {
      return false;
    }
    throw err;
  }
}
