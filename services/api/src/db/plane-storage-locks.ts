/* eslint-disable max-lines */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type ConnectionRecord,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

/** Interpret DynamoDB conditional failures while preserving all other errors. */
export function conditionalHostWriteOrThrow(err: unknown): false {
  if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
  throw err;
}

export function connectionPageItems(items: ConnectionRecord[] | undefined): ConnectionRecord[] {
  return items ?? [];
}

export function nextConnectionPage(
  key: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return key && Object.keys(key).length > 0 ? key : undefined;
}

/**
 * Conditional agent lock (Invariant 3).
 * Returns false if hostId already locked and replace is false.
 */
export async function tryAcquireHostLock(
  ctx: PlaneStorageCtx,
  opts: { hostId: string; connectionId: string; replaceExisting: boolean; draining?: boolean },
): Promise<boolean> {
  if (opts.replaceExisting) {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          connectionId: opts.connectionId,
          draining: opts.draining ?? false,
          mainCheckoutLeases: {},
        },
      }),
    );
    return true;
  }
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.hostLocks,
        Item: {
          hostId: opts.hostId,
          connectionId: opts.connectionId,
          draining: opts.draining ?? false,
          mainCheckoutLeases: {},
        },
        ConditionExpression: "attribute_not_exists(hostId)",
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

/**
 * Acquire the host lease and persist the connection atomically. The lock is
 * the authority for duplicate registration; putting the connection first (or
 * queueing either write) leaves a window where two API processes disagree
 * about the owner.
 */
export async function tryRegisterHost(
  ctx: PlaneStorageCtx,
  opts: {
    hostId: string;
    connection: ConnectionRecord;
    replaceExisting: boolean;
    existingConnectionId?: string;
    consumePendingConnection?: boolean;
    draining?: boolean;
  },
): Promise<boolean> {
  try {
    // A fresh API process may not yet have the current owner in its local
    // cache. Resolve it from DynamoDB and use that exact value in the
    // transaction; otherwise force-replacement overwrites the lease but leaks
    // the prior connection row forever.
    const existingConnectionId = opts.replaceExisting
      ? (opts.existingConnectionId ?? (await getHostLock(ctx, opts.hostId)))
      : undefined;
    const lockValues = existingConnectionId
      ? {
          ":connectionId": opts.connection.connectionId,
          ":existing": existingConnectionId,
          ":draining": opts.draining ?? false,
          ":false": false,
          ":empty": {},
        }
      : {
          ":connectionId": opts.connection.connectionId,
          ":draining": opts.draining ?? false,
          ":false": false,
          ":true": true,
          ":empty": {},
        };
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression:
                "SET connectionId = :connectionId, draining = :draining, disconnected = :false, mainCheckoutLeases = if_not_exists(mainCheckoutLeases, :empty)",
              ...(opts.replaceExisting
                ? existingConnectionId
                  ? {
                      ConditionExpression:
                        "attribute_not_exists(connectionId) OR connectionId = :existing",
                    }
                  : {
                      // `getHostLock` deliberately hides a disconnected row.
                      // A force registration may replace that row, but must not
                      // overwrite an unseen live owner from another process.
                      ConditionExpression:
                        "attribute_not_exists(connectionId) OR disconnected = :true",
                    }
                : {
                    ConditionExpression:
                      "attribute_not_exists(connectionId) OR disconnected = :true",
                  }),
              ExpressionAttributeValues: lockValues,
            },
          },
          {
            Put: {
              TableName: ctx.tables.connections,
              Item: { ...opts.connection },
              ConditionExpression: opts.consumePendingConnection
                ? "attribute_not_exists(connectionId) OR (connectionId = :pendingConnectionId AND hostId = :pendingHostId AND registered = :false)"
                : "attribute_not_exists(connectionId)",
              ...(opts.consumePendingConnection
                ? {
                    ExpressionAttributeValues: {
                      ":false": false,
                      ":pendingConnectionId": opts.connection.connectionId,
                      ":pendingHostId": opts.hostId,
                    },
                  }
                : {}),
            },
          },
          ...(existingConnectionId
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.connections,
                    Key: { connectionId: existingConnectionId },
                  },
                },
              ]
            : []),
        ],
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

/** Release both the connection row and its host lease, guarded by ownership. */
export async function releaseHostConnection(
  ctx: PlaneStorageCtx,
  opts: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: ctx.tables.connections,
              Key: { connectionId: opts.connectionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression: "SET disconnected = :true REMOVE draining",
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId, ":true": true },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

/** Update a heartbeat only while this connection still owns the host lease. */
export async function heartbeatConnection(
  ctx: PlaneStorageCtx,
  opts: { hostId: string; connectionId: string; at: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.connections,
              Key: { connectionId: opts.connectionId },
              UpdateExpression: "SET lastHeartbeatAt = :at",
              ConditionExpression: "hostId = :hostId",
              ExpressionAttributeValues: { ":at": opts.at, ":hostId": opts.hostId },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

/**
 * Persist a host drain against the exact lease owner. Assignment transactions
 * check this flag, so a scheduler with a stale worktree cache cannot commit
 * work after the drain request has completed.
 */
export async function markHostDraining(
  ctx: PlaneStorageCtx,
  opts: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.hostLocks,
        Key: { hostId: opts.hostId },
        UpdateExpression: "SET draining = :true",
        ConditionExpression: "connectionId = :connectionId",
        ExpressionAttributeValues: { ":true": true, ":connectionId": opts.connectionId },
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

export async function releaseHostLock(
  ctx: PlaneStorageCtx,
  hostId: string,
  connectionId: string,
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.hostLocks,
        Key: { hostId },
        ConditionExpression: "connectionId = :c",
        ExpressionAttributeValues: { ":c": connectionId },
      }),
    );
  } catch (err) {
    conditionalHostWriteOrThrow(err);
  }
}

export async function getHostLock(ctx: PlaneStorageCtx, hostId: string): Promise<string | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostLocks, Key: { hostId } }),
  );
  if (res.Item?.disconnected === true) return null;
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
        ConsistentRead: true,
      }),
    );
    items.push(...connectionPageItems(res.Items as ConnectionRecord[] | undefined));
    startKey = nextConnectionPage(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return items;
}
