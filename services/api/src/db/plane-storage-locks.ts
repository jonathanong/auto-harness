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
import { nextPageKey } from "./plane-storage-types.ts";

/** Interpret DynamoDB conditional failures while preserving all other errors. */
export function conditionalHostWriteOrThrow(err: unknown): false {
  if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
  throw err;
}

export function connectionPageItems(items: ConnectionRecord[] | undefined): ConnectionRecord[] {
  return items ?? [];
}

/** A disconnected-host alert that remains retryable after its lease is released. */
export type HostOfflineAlertCandidate = {
  hostId: string;
  reason: string;
  lastHeartbeatAt: string;
};

/**
 * Conditional agent lock (Invariant 3).
 * Returns false if hostId already locked and replace is false.
 */
export async function tryAcquireHostLock(
  ctx: PlaneStorageCtx,
  opts: {
    hostId: string;
    connectionId: string;
    replaceExisting: boolean;
    draining?: boolean | undefined;
  },
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
    draining?: boolean | undefined;
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
                "SET connectionId = :connectionId, draining = :draining, disconnected = :false, mainCheckoutLeases = if_not_exists(mainCheckoutLeases, :empty) REMOVE offlineAlertReason, offlineAlertLastHeartbeatAt",
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
  opts: {
    hostId: string;
    connectionId: string;
    offlineAlert?: Omit<HostOfflineAlertCandidate, "hostId">;
  },
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
              UpdateExpression: opts.offlineAlert
                ? "SET disconnected = :true, offlineAlertReason = :reason, offlineAlertLastHeartbeatAt = :lastHeartbeatAt REMOVE draining"
                : "SET disconnected = :true REMOVE draining",
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: {
                ":connectionId": opts.connectionId,
                ":true": true,
                ...(opts.offlineAlert
                  ? {
                      ":reason": opts.offlineAlert.reason,
                      ":lastHeartbeatAt": opts.offlineAlert.lastHeartbeatAt,
                    }
                  : {}),
              },
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
 * Record a retry candidate for an already-disconnected or unknown host without
 * touching a replacement's live lease. This covers rows written before alert
 * persistence was added and local-process disconnect observations.
 */
export async function recordHostOfflineAlertCandidate(
  ctx: PlaneStorageCtx,
  candidate: HostOfflineAlertCandidate,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.hostLocks,
        Key: { hostId: candidate.hostId },
        UpdateExpression:
          "SET disconnected = :true, offlineAlertReason = :reason, offlineAlertLastHeartbeatAt = :lastHeartbeatAt REMOVE draining",
        // A stale warm Lambda may retry after a newer disconnect has already
        // recorded its own candidate. Only create a missing candidate (or
        // repeat this exact one); never replace a newer alert observation.
        ConditionExpression:
          "(attribute_not_exists(connectionId) OR disconnected = :true) AND (attribute_not_exists(offlineAlertReason) OR attribute_not_exists(offlineAlertLastHeartbeatAt) OR (offlineAlertReason = :reason AND offlineAlertLastHeartbeatAt = :lastHeartbeatAt))",
        ExpressionAttributeValues: {
          ":true": true,
          ":reason": candidate.reason,
          ":lastHeartbeatAt": candidate.lastHeartbeatAt,
        },
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

/** A conditional clear cannot erase a newer disconnect candidate for the same host. */
export async function clearHostOfflineAlertCandidate(
  ctx: PlaneStorageCtx,
  candidate: HostOfflineAlertCandidate,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.hostLocks,
        Key: { hostId: candidate.hostId },
        UpdateExpression: "REMOVE offlineAlertReason, offlineAlertLastHeartbeatAt",
        ConditionExpression:
          "offlineAlertReason = :reason AND offlineAlertLastHeartbeatAt = :lastHeartbeatAt",
        ExpressionAttributeValues: {
          ":reason": candidate.reason,
          ":lastHeartbeatAt": candidate.lastHeartbeatAt,
        },
      }),
    );
    return true;
  } catch (err) {
    return conditionalHostWriteOrThrow(err);
  }
}

function hostOfflineAlertCandidate(
  item: Record<string, unknown>,
): HostOfflineAlertCandidate | undefined {
  const hostId = item.hostId;
  const reason = item.offlineAlertReason;
  const lastHeartbeatAt = item.offlineAlertLastHeartbeatAt;
  if (
    typeof hostId !== "string" ||
    typeof reason !== "string" ||
    typeof lastHeartbeatAt !== "string"
  ) {
    return undefined;
  }
  return { hostId, reason, lastHeartbeatAt };
}

/** Scan only durable retry candidates; host locks are one row per known host. */
export async function listHostOfflineAlertCandidates(
  ctx: PlaneStorageCtx,
): Promise<HostOfflineAlertCandidate[]> {
  const candidates: HostOfflineAlertCandidate[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.hostLocks,
        FilterExpression:
          "attribute_exists(offlineAlertReason) AND attribute_exists(offlineAlertLastHeartbeatAt)",
        ExclusiveStartKey: startKey,
        ConsistentRead: true,
      }),
    );
    for (const item of result.Items ?? []) {
      const candidate = hostOfflineAlertCandidate(item as Record<string, unknown>);
      if (candidate) candidates.push(candidate);
    }
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return candidates.toSorted((left, right) => left.hostId.localeCompare(right.hostId));
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

export type HostLockState = {
  connectionId: string | null;
  draining: boolean;
};

export async function getHostLockState(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<HostLockState> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostLocks, Key: { hostId } }),
  );
  if (res.Item?.disconnected === true) return { connectionId: null, draining: false };
  return {
    connectionId: (res.Item?.connectionId as string | undefined) ?? null,
    draining: res.Item?.draining === true,
  };
}

export async function getHostLock(ctx: PlaneStorageCtx, hostId: string): Promise<string | null> {
  return (await getHostLockState(ctx, hostId)).connectionId;
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
      ConsistentRead: true,
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
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return items;
}
