import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  type ConnectionRecord,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

/**
 * Conditional agent lock (Invariant 3).
 * Returns false if agentId already locked and replace is false.
 */
export async function tryAcquireAgentLock(
  ctx: PlaneStorageCtx,
  opts: { agentId: string; connectionId: string; replaceExisting: boolean },
): Promise<boolean> {
  if (opts.replaceExisting) {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.agentLocks,
        Item: { agentId: opts.agentId, connectionId: opts.connectionId },
      }),
    );
    return true;
  }
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.agentLocks,
        Item: { agentId: opts.agentId, connectionId: opts.connectionId },
        ConditionExpression: "attribute_not_exists(agentId)",
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

export async function releaseAgentLock(
  ctx: PlaneStorageCtx,
  agentId: string,
  connectionId: string,
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.agentLocks,
        Key: { agentId },
        ConditionExpression: "connectionId = :c",
        ExpressionAttributeValues: { ":c": connectionId },
      }),
    );
  } catch (err) {
    if (isConditionalFailed(err)) {
      return;
    }
    throw err;
  }
}

export async function getAgentLock(ctx: PlaneStorageCtx, agentId: string): Promise<string | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.agentLocks, Key: { agentId } }),
  );
  return (res.Item?.connectionId as string | undefined) ?? null;
}

export async function putConnection(ctx: PlaneStorageCtx, conn: ConnectionRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.connections,
      Item: { ...conn },
    }),
  );
}

export async function getConnection(
  ctx: PlaneStorageCtx,
  connectionId: string,
): Promise<ConnectionRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.connections,
      Key: { connectionId },
    }),
  );
  return (res.Item as ConnectionRecord | undefined) ?? null;
}

export async function deleteConnection(ctx: PlaneStorageCtx, connectionId: string): Promise<void> {
  await ctx.doc.send(
    new DeleteCommand({
      TableName: ctx.tables.connections,
      Key: { connectionId },
    }),
  );
}

export async function listConnections(ctx: PlaneStorageCtx): Promise<ConnectionRecord[]> {
  const items: ConnectionRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.connections,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as ConnectionRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}
