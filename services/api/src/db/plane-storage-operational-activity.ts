import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

type TransactionItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export type OperationalActivity = {
  scopeKey: string;
  recordKey: string;
  recordType: "operational-activity-v2";
  sessionId: string;
  repositoryId: string;
  generation: string;
};

const LEDGER_SCOPE = "__operational-activity#v2#ready";
const LEDGER_RECORD = "READY";
const RECORD_PREFIX = "ACT#";

function operationalActivityScope(shard: number): string {
  return `__active#v2#${shard}`;
}

export function repositoryActivityScope(repositoryId: string): string {
  return `__repo#v2#${encodeURIComponent(repositoryId)}`;
}

export function operationalActivityReadyRecord(): Record<string, string> {
  return {
    scopeKey: LEDGER_SCOPE,
    recordKey: LEDGER_RECORD,
    recordType: "operational-activity-ready-v2",
  };
}

export function repositoryActivityForSession(
  session: Pick<SessionRecord, "id" | "repositoryId" | "createdAt">,
): OperationalActivity | null {
  if (!session.repositoryId) return null;
  return {
    scopeKey: repositoryActivityScope(session.repositoryId),
    recordKey: `${RECORD_PREFIX}${session.id}`,
    recordType: "operational-activity-v2",
    sessionId: session.id,
    repositoryId: session.repositoryId,
    generation: session.createdAt,
  };
}

export function activeActivityForAssignment(input: {
  sessionId: string;
  repositoryId: string;
  queueShard: number;
  attemptId: string;
}): OperationalActivity {
  return {
    scopeKey: operationalActivityScope(input.queueShard),
    recordKey: `${RECORD_PREFIX}${input.sessionId}`,
    recordType: "operational-activity-v2",
    sessionId: input.sessionId,
    repositoryId: input.repositoryId,
    generation: input.attemptId,
  };
}

export function sessionNeedsOperationalRecovery(session: SessionRecord): boolean {
  return (
    session.status === "running" ||
    session.worktreeId != null ||
    session.workspaceSlotId != null ||
    session.workspaceSlotLease === true ||
    session.mainCheckoutLease === true ||
    session.activeHostId !== undefined ||
    session.reconnectDeadlineAt !== undefined ||
    session.providerAccountLease !== undefined ||
    session.hostAssignmentLease !== undefined ||
    session.terminalHookHandoff !== undefined ||
    (session.errorCode === "checkout_fetch_failed" &&
      !session.terminalHookLifecycleEnqueuedAt &&
      (session.terminalHookHandoffExpiredAt !== undefined ||
        session.terminalHookHandoffSettled !== undefined))
  );
}

export function operationalActivitiesForBackfill(session: SessionRecord): OperationalActivity[] {
  const active = sessionNeedsOperationalRecovery(session)
    ? [
        activeActivityForAssignment({
          sessionId: session.id,
          repositoryId: session.repositoryId,
          queueShard: session.queueShard,
          attemptId: session.attemptId ?? session.createdAt,
        }),
      ]
    : [];
  const repository = repositoryActivityForSession(session);
  if (repository && (session.status === "queued" || sessionNeedsOperationalRecovery(session))) {
    active.push(repository);
  }
  return active;
}

export function activityPut(ctx: PlaneStorageCtx, activity: OperationalActivity): TransactionItem {
  return { Put: { TableName: ctx.tables.sessionDrains, Item: activity } };
}

export async function assertOperationalActivityReady(ctx: PlaneStorageCtx): Promise<void> {
  const record = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: LEDGER_SCOPE, recordKey: LEDGER_RECORD },
      ConsistentRead: true,
    }),
  );
  if (record.Item?.recordType !== "operational-activity-ready-v2") {
    throw new Error("operational activity ledger is not ready");
  }
}

async function listActivityPage(
  ctx: PlaneStorageCtx,
  scopeKey: string,
  startKey: Record<string, unknown> | undefined,
  limit: number,
): Promise<{ records: OperationalActivity[]; nextKey?: Record<string, unknown> }> {
  const result = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessionDrains,
      KeyConditionExpression: "scopeKey = :scope AND begins_with(recordKey, :prefix)",
      ExpressionAttributeValues: { ":scope": scopeKey, ":prefix": RECORD_PREFIX },
      ConsistentRead: true,
      Limit: Math.max(1, Math.min(25, limit)),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  const nextKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  return {
    records: (result.Items ?? []) as OperationalActivity[],
    ...(nextKey ? { nextKey } : {}),
  };
}

export function listOperationalActivityPage(
  ctx: PlaneStorageCtx,
  shard: number,
  startKey?: Record<string, unknown>,
  limit = 25,
) {
  return listActivityPage(ctx, operationalActivityScope(shard), startKey, limit);
}

export function listRepositoryActivityPage(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  startKey?: Record<string, unknown>,
  limit = 25,
) {
  return listActivityPage(ctx, repositoryActivityScope(repositoryId), startKey, limit);
}

export async function deleteOperationalActivity(
  ctx: PlaneStorageCtx,
  activity: OperationalActivity,
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.sessionDrains,
        Key: { scopeKey: activity.scopeKey, recordKey: activity.recordKey },
        ConditionExpression:
          "recordType = :type AND sessionId = :sessionId AND generation = :generation",
        ExpressionAttributeValues: {
          ":type": activity.recordType,
          ":sessionId": activity.sessionId,
          ":generation": activity.generation,
        },
      }),
    );
  } catch (error) {
    if (!isConditionalFailed(error)) throw error;
  }
}
