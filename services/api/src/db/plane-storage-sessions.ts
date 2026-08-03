import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";
import {
  itemToSession,
  isConditionalFailed,
  sessionToItem,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

export async function putSession(ctx: PlaneStorageCtx, session: SessionRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessions,
      Item: sessionToItem(session),
    }),
  );
}

export async function getSession(ctx: PlaneStorageCtx, id: string): Promise<SessionRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.sessions, Key: { id } }));
  return res.Item ? itemToSession(res.Item) : null;
}

export async function listAllSessions(ctx: PlaneStorageCtx): Promise<SessionRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessions,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items.map(itemToSession);
}

export async function listSessionsByStatus(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
): Promise<SessionRecord[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessions,
      IndexName: "statusShard-createdAt",
      KeyConditionExpression: "statusShard = :ss",
      ExpressionAttributeValues: {
        ":ss": statusShardAttr(status, shard),
      },
    }),
  );
  return (res.Items ?? []).map((i) => itemToSession(i as Record<string, unknown>));
}

export async function putWorktree(ctx: PlaneStorageCtx, wt: WorktreeRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.worktrees,
      Item: { ...wt },
    }),
  );
}

export async function getWorktree(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<WorktreeRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.worktrees, Key: { id } }));
  return (res.Item as WorktreeRecord | undefined) ?? null;
}

export async function listAllWorktrees(ctx: PlaneStorageCtx): Promise<WorktreeRecord[]> {
  const items: WorktreeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.worktrees,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as WorktreeRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

export async function listWorktreesForRepo(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<WorktreeRecord[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.worktrees,
      IndexName: "repositoryId-id",
      KeyConditionExpression: "repositoryId = :r",
      ExpressionAttributeValues: { ":r": repositoryId },
    }),
  );
  return (res.Items ?? []) as WorktreeRecord[];
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

export async function releaseWorktree(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  opts?: { forceOffline?: boolean },
): Promise<void> {
  const wt = await getWorktree(ctx, worktreeId);
  if (!wt) {
    return;
  }
  const online = opts?.forceOffline ? false : wt.online;
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
      ExpressionAttributeNames: { "#s": "status", "#o": "online" },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":online": online,
      },
    }),
  );
}

export async function setWorktreeOnline(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  online: boolean,
): Promise<void> {
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #o = :o",
      ExpressionAttributeNames: { "#o": "online" },
      ExpressionAttributeValues: { ":o": online },
    }),
  );
}
