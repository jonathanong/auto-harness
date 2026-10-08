import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import {
  assertOperationalActivityReady,
  deleteOperationalActivity,
  listOperationalActivityPage,
  listRepositoryActivityPage,
  sessionNeedsOperationalRecovery,
  type OperationalActivity,
} from "./plane-storage-operational-activity.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const PAGE_SIZE = 25;
const EXACT_READ_CONCURRENCY = 20;
/** A complete lease snapshot is required before assignment; overflow fails closed. */
const MAX_ACTIVE_SNAPSHOT = 2_000;

export class OperationalSnapshotOverflowError extends Error {}

export type OperationalRecoverySweep = "ack" | "reconnect" | "timeout";

/** Each recovery sweep advances one durable ACT page, independent of capacity hydration. */
export async function listOperationalRecoveryPage(
  ctx: PlaneStorageCtx,
  kind: OperationalRecoverySweep,
  shardCount: number,
): Promise<SessionRecord[]> {
  await assertOperationalActivityReady(ctx);
  if (shardCount < 1) return [];
  const key = { scopeKey: "__operational-activity#v2#cursor", recordKey: kind };
  const saved = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: key,
      ConsistentRead: true,
    }),
  );
  const savedShard = saved.Item?.shard;
  const shard =
    typeof savedShard === "number" && savedShard >= 0 && savedShard < shardCount ? savedShard : 0;
  const cursor = saved.Item?.nextKey as Record<string, unknown> | undefined;
  const page = await listOperationalActivityPage(ctx, shard, cursor, PAGE_SIZE);
  const sessions: SessionRecord[] = [];
  for (const { activity, session } of await resolvePage(ctx, page.records)) {
    if (session && sessionNeedsOperationalRecovery(session)) sessions.push(session);
    else await deleteOperationalActivity(ctx, activity);
  }
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionDrains,
      Item: {
        ...key,
        shard: page.nextKey ? shard : (shard + 1) % shardCount,
        ...(page.nextKey ? { nextKey: page.nextKey } : {}),
      },
    }),
  );
  return sessions;
}

async function resolvePage(
  ctx: PlaneStorageCtx,
  activities: readonly OperationalActivity[],
): Promise<Array<{ activity: OperationalActivity; session: SessionRecord | null }>> {
  const resolved: Array<{ activity: OperationalActivity; session: SessionRecord | null }> = [];
  for (let offset = 0; offset < activities.length; offset += EXACT_READ_CONCURRENCY) {
    resolved.push(
      ...(await Promise.all(
        activities.slice(offset, offset + EXACT_READ_CONCURRENCY).map(async (activity) => ({
          activity,
          session: await getSession(ctx, activity.sessionId, true),
        })),
      )),
    );
  }
  return resolved;
}

export async function listOperationalSessions(
  ctx: PlaneStorageCtx,
  shardCount: number,
): Promise<SessionRecord[]> {
  await assertOperationalActivityReady(ctx);
  const sessions: SessionRecord[] = [];
  let observed = 0;
  for (let shard = 0; shard < shardCount; shard += 1) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await listOperationalActivityPage(ctx, shard, cursor, PAGE_SIZE);
      observed += page.records.length;
      if (observed > MAX_ACTIVE_SNAPSHOT) {
        throw new OperationalSnapshotOverflowError(
          "operational session snapshot exceeds its safe per-run bound",
        );
      }
      for (const { activity, session } of await resolvePage(ctx, page.records)) {
        if (session && sessionNeedsOperationalRecovery(session)) {
          sessions.push(session);
        } else {
          await deleteOperationalActivity(ctx, activity);
        }
      }
      cursor = page.nextKey;
    } while (cursor);
  }
  return sessions;
}

/** A completed repository drain uses the base-table member scope, never a GSI. */
export async function listRepositoryOperationalPage(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  cursor?: Record<string, unknown>,
): Promise<{
  sessions: SessionRecord[];
  observedMembers: number;
  nextKey?: Record<string, unknown>;
}> {
  await assertOperationalActivityReady(ctx);
  const page = await listRepositoryActivityPage(ctx, repositoryId, cursor, PAGE_SIZE);
  const sessions: SessionRecord[] = [];
  for (const { activity, session } of await resolvePage(ctx, page.records)) {
    if (
      session &&
      session.repositoryId === repositoryId &&
      (session.status === "queued" || sessionNeedsOperationalRecovery(session))
    ) {
      sessions.push(session);
      continue;
    }
    await deleteRepositoryActivityIfInactive(ctx, activity, session);
  }
  return {
    sessions,
    observedMembers: page.records.length,
    ...(page.nextKey ? { nextKey: page.nextKey } : {}),
  };
}

async function deleteRepositoryActivityIfInactive(
  ctx: PlaneStorageCtx,
  activity: OperationalActivity,
  session: SessionRecord | null,
): Promise<void> {
  // Unlike an ACTIVE member, a REPO member is not rewritten on every retry.
  // Couple deletion to the exact terminal session state so an old read cannot
  // erase membership after a concurrent requeue or new handoff.
  const currentGeneration = session?.createdAt;
  if (currentGeneration && currentGeneration !== activity.generation) {
    await deleteOperationalActivity(ctx, activity);
    return;
  }
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.sessions,
              Key: { id: activity.sessionId },
              ConditionExpression:
                "attribute_not_exists(id) OR (#s IN (:completed,:failed,:cancelled,:timedOut) AND (attribute_not_exists(worktreeId) OR worktreeId = :null) AND (attribute_not_exists(workspaceSlotId) OR workspaceSlotId = :null) AND attribute_not_exists(mainCheckoutLease) AND attribute_not_exists(workspaceSlotLease) AND attribute_not_exists(providerAccountLease) AND attribute_not_exists(hostAssignmentLease) AND attribute_not_exists(activeHostId) AND attribute_not_exists(terminalHookHandoff) AND attribute_not_exists(reconnectDeadlineAt) AND (attribute_not_exists(errorCode) OR errorCode <> :checkout OR (attribute_not_exists(terminalHookHandoffSettled) AND attribute_not_exists(terminalHookHandoffExpiredAt)) OR attribute_exists(terminalHookLifecycleEnqueuedAt)))",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":completed": "completed",
                ":failed": "failed",
                ":cancelled": "cancelled",
                ":timedOut": "timed_out",
                ":null": null,
                ":checkout": "checkout_fetch_failed",
              },
            },
          },
          {
            Delete: {
              TableName: ctx.tables.sessionDrains,
              Key: { scopeKey: activity.scopeKey, recordKey: activity.recordKey },
              ConditionExpression:
                "recordType = :type AND sessionId = :sessionId AND generation = :generation",
              ExpressionAttributeValues: {
                ":type": activity.recordType,
                ":sessionId": activity.sessionId,
                ":generation": activity.generation,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isConditionalTransactionFailed(error)) throw error;
  }
}
