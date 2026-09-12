/* eslint-disable max-lines -- workspace pool, slot, and atomic assignment storage share one boundary. */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { activeHostOrder } from "./plane-storage-sessions-active-host.ts";
import {
  assignmentLeaseCollision,
  isConditionalFailed,
  isConditionalTransactionFailed,
  type AssignmentWriteResult,
  type PlaneStorageCtx,
  type WorkspacePoolRecord,
} from "./plane-storage-types.ts";
import { nextPageKey } from "./plane-storage-types.ts";
import { providerAccountLastAssignedTransactItem } from "./plane-storage-provider-account-assignment.ts";
import { hostAssignmentAcquireItem } from "./plane-storage-host-assignment.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./types.ts";
import { ownedDelete, type OwnedDeletionMarker } from "./plane-storage-deletion-markers.ts";

export async function putWorkspacePool(
  ctx: PlaneStorageCtx,
  record: WorkspacePoolRecord,
): Promise<void> {
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.workspacePools, Item: record }));
}

/** Replace an existing pool without allowing a racing delete to be resurrected. */
export async function updateWorkspacePool(
  ctx: PlaneStorageCtx,
  record: WorkspacePoolRecord,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.workspacePools,
        Item: record,
        ConditionExpression: "attribute_exists(id)",
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

export async function createWorkspacePool(
  ctx: PlaneStorageCtx,
  record: WorkspacePoolRecord,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.workspacePools,
        Item: record,
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

export async function getWorkspacePool(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<WorkspacePoolRecord | null> {
  const result = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.workspacePools, Key: { id }, ConsistentRead: true }),
  );
  return (result.Item as WorkspacePoolRecord | undefined) ?? null;
}

export async function listWorkspacePools(ctx: PlaneStorageCtx): Promise<WorkspacePoolRecord[]> {
  const records: WorkspacePoolRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.workspacePools,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((result.Items ?? []) as WorkspacePoolRecord[]));
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);
  return records;
}

export async function deleteWorkspacePool(
  ctx: PlaneStorageCtx,
  id: string,
  markers?: readonly OwnedDeletionMarker[],
): Promise<boolean> {
  if (markers?.length) {
    await ownedDelete(ctx, markers, {
      Delete: { TableName: ctx.tables.workspacePools, Key: { id } },
    });
    return true;
  }
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.workspacePools,
        Key: { id },
        ConditionExpression: "attribute_exists(id)",
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

export async function putWorkspaceSlot(
  ctx: PlaneStorageCtx,
  slot: WorkspaceSlotRecord,
): Promise<void> {
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.workspaceSlots, Item: slot }));
}

/** Publish a slot only while its host connection still owns the row. */
export async function putWorkspaceSlotFenced(
  ctx: PlaneStorageCtx,
  slot: WorkspaceSlotRecord,
  _connectionId: string,
  expectedConnectionId?: string,
): Promise<boolean> {
  try {
    const ownership = expectedConnectionId
      ? "connectionId = :expectedConnectionId"
      : "attribute_not_exists(connectionId)";
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.workspaceSlots,
        Item: slot,
        ConditionExpression:
          `attribute_not_exists(id) OR (${ownership} AND #status = :expectedStatus` +
          " AND (attribute_not_exists(currentSessionId) OR currentSessionId = :null))",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ...(expectedConnectionId ? { ":expectedConnectionId": expectedConnectionId } : {}),
          ":expectedStatus": slot.status,
          ":null": null,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

export async function deleteWorkspaceSlot(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.workspaceSlots, Key: { id } }));
}

export async function getWorkspaceSlot(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<WorkspaceSlotRecord | null> {
  const result = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.workspaceSlots, Key: { id }, ConsistentRead: true }),
  );
  return (result.Item as WorkspaceSlotRecord | undefined) ?? null;
}

export async function listWorkspaceSlots(ctx: PlaneStorageCtx): Promise<WorkspaceSlotRecord[]> {
  const records: WorkspaceSlotRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.workspaceSlots,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((result.Items ?? []) as WorkspaceSlotRecord[]));
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);
  return records;
}

async function querySlots(
  ctx: PlaneStorageCtx,
  indexName: "workspacePoolId-id" | "hostId-id",
  key: "workspacePoolId" | "hostId",
  value: string,
): Promise<WorkspaceSlotRecord[]> {
  const records: WorkspaceSlotRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.workspaceSlots,
        IndexName: indexName,
        KeyConditionExpression: "#key = :value",
        ExpressionAttributeNames: { "#key": key },
        ExpressionAttributeValues: { ":value": value },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((result.Items ?? []) as WorkspaceSlotRecord[]));
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);
  return records;
}

export const listWorkspaceSlotsByPool = (ctx: PlaneStorageCtx, workspacePoolId: string) =>
  querySlots(ctx, "workspacePoolId-id", "workspacePoolId", workspacePoolId);

export const listWorkspaceSlotsByHost = (ctx: PlaneStorageCtx, hostId: string) =>
  querySlots(ctx, "hostId-id", "hostId", hostId);

export async function tryAssignWorkspaceSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    workspacePoolId: string;
    workspaceSlotId: string;
    hostId: string;
    connectionId: string;
    now: string;
    attemptId: string;
    resolvedArgv: string[];
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    providerId?: string;
    providerAccountLease?: SessionRecord["providerAccountLease"];
    hostAssignmentLease?: SessionRecord["hostAssignmentLease"];
    hostAssignmentCap?: number;
    legacyAssignmentCount?: number;
    queueShard: number;
  },
): Promise<AssignmentWriteResult> {
  const values: Record<string, unknown> = {
    ":running": "running",
    ":queued": "queued",
    ":statusShard": statusShardAttr("running", opts.queueShard),
    ":poolId": opts.workspacePoolId,
    ":slotId": opts.workspaceSlotId,
    ":hostId": opts.hostId,
    ":now": opts.now,
    ":attemptId": opts.attemptId,
    ":argv": opts.resolvedArgv,
    ":route": opts.resolvedRoute,
    ":connectionId": opts.connectionId,
    ":true": true,
    ":hostAssignmentLease": opts.hostAssignmentLease ?? { hostId: opts.hostId },
    ":activeHostOrder": activeHostOrder(opts.now, opts.sessionId),
  };
  const sets = [
    "#s = :running",
    "statusShard = :statusShard",
    "workspacePoolId = :poolId",
    "workspaceSlotId = :slotId",
    "workspaceSlotLease = :true",
    "worktreeId = :null",
    "hostId = :hostId",
    "activeHostId = :hostId",
    "activeHostOrder = :activeHostOrder",
    "startedAt = :now",
    "assignmentSentAt = :now",
    "attemptId = :attemptId",
    "resolvedArgv = :argv",
    "resolvedRoute = :route",
    "assignmentConnectionId = :connectionId",
    "hostAssignmentLease = :hostAssignmentLease",
  ];
  values[":null"] = null;
  if (opts.providerAccountLease) {
    sets.push("providerAccountLease = :providerAccountLease");
    values[":providerAccountLease"] = opts.providerAccountLease;
  }
  const lease = opts.hostAssignmentLease ?? { hostId: opts.hostId };
  const items = [
    {
      ConditionCheck: {
        TableName: ctx.tables.workspacePools,
        Key: { id: opts.workspacePoolId },
        ConditionExpression: "attribute_exists(id)",
      },
    },
    {
      Update: {
        TableName: ctx.tables.workspaceSlots,
        Key: { id: opts.workspaceSlotId },
        UpdateExpression:
          "SET #s = :busy, currentSessionId = :sessionId, lastAssignedAt = :now, connectionId = :connectionId",
        ConditionExpression:
          "workspacePoolId = :poolId AND hostId = :hostId AND #s = :idle AND online = :true",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":poolId": opts.workspacePoolId,
          ":hostId": opts.hostId,
          ":idle": "idle",
          ":true": true,
          ":busy": "busy",
          ":sessionId": opts.sessionId,
          ":now": opts.now,
          ":connectionId": opts.connectionId,
        },
      },
    },
    {
      Update: {
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression: `SET ${sets.join(", ")} REMOVE ackReceivedAt, reconnectDeadlineAt, retryAfter, retryCount`,
        ConditionExpression: "#s = :queued AND queueExpiresAt > :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
      },
    },
    hostAssignmentAcquireItem(ctx, {
      ...lease,
      connectionId: opts.connectionId,
      ...(opts.hostAssignmentCap !== undefined ? { cap: opts.hostAssignmentCap } : {}),
      ...(opts.legacyAssignmentCount !== undefined
        ? { legacyAssignmentCount: opts.legacyAssignmentCount }
        : {}),
    }),
    ...(opts.providerAccountId
      ? [
          providerAccountLastAssignedTransactItem(ctx, {
            providerAccountId: opts.providerAccountId,
            ...(opts.providerId ? { providerId: opts.providerId } : {}),
            now: opts.now,
            ...(opts.providerAccountLease ? { slot: opts.providerAccountLease.slot } : {}),
          }),
        ]
      : []),
    ...(opts.providerAccountLease
      ? [
          {
            Put: {
              TableName: ctx.tables.concurrencyLocks,
              Item: {
                concurrencyId: opts.providerAccountLease.concurrencyId,
                sessionId: opts.sessionId,
                attemptId: opts.attemptId,
                providerAccountId: opts.providerAccountLease.providerAccountId,
                slot: opts.providerAccountLease.slot,
                hostId: opts.hostId,
              },
              ConditionExpression: "attribute_not_exists(concurrencyId)",
            },
          },
        ]
      : []),
  ];
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (assignmentLeaseCollision(error, opts.providerAccountLease ? items.length - 1 : undefined)) {
      return "lease_collision";
    }
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}
