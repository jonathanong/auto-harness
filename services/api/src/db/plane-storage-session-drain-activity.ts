import { GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import { sessionDrainActivityKey, sessionDrainScopeKey } from "./plane-storage-session-drains.ts";
import { itemToSession, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

type TransactionItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

type SessionDrainActivityKey = { scopeKey: string; recordKey: string; sessionId: string };

function sessionDrainActivityForSession(session: SessionRecord): SessionDrainActivityKey | null {
  const principalId = sessionPrincipalId(session);
  if (!principalId) return null;
  return {
    scopeKey: sessionDrainScopeKey(session.repositoryId, principalId),
    recordKey: sessionDrainActivityKey(session.id),
    sessionId: session.id,
  };
}

export async function readSessionDrainActivity(
  ctx: PlaneStorageCtx,
  sessionId: string,
): Promise<{ session: SessionRecord; activity: SessionDrainActivityKey | null } | null> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessions,
      Key: { id: sessionId },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  const session = itemToSession(result.Item as Record<string, unknown>);
  return { session, activity: sessionDrainActivityForSession(session) };
}

/**
 * Delete is intentionally unconditional. Session IDs and their owner are
 * immutable after admission, so this exact `(scope, ACT#id)` can never belong
 * to a different live session. That keeps terminal cleanup idempotent for a
 * legacy row with no activity member and for a retry after a prior success.
 */
export function sessionDrainActivityDelete(
  ctx: PlaneStorageCtx,
  activity: SessionDrainActivityKey | null,
): TransactionItem[] {
  if (!activity) return [];
  return [
    {
      Delete: {
        TableName: ctx.tables.sessionDrains,
        Key: { scopeKey: activity.scopeKey, recordKey: activity.recordKey },
      },
    },
  ];
}
