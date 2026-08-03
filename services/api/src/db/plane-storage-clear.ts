import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { listAllSessions, listAllWorktrees } from "./plane-storage-sessions.ts";
import { listConnections } from "./plane-storage-locks.ts";
import { listArchives, listRepositories, listSchedules } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

/** Test helper: wipe all items in every table (DynamoDB Local). */
export async function clearAll(ctx: PlaneStorageCtx): Promise<void> {
  for (const session of await listAllSessions(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({ TableName: ctx.tables.sessions, Key: { id: session.id } }),
    );
  }
  for (const wt of await listAllWorktrees(ctx)) {
    await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.worktrees, Key: { id: wt.id } }));
  }
  for (const c of await listConnections(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.connections,
        Key: { connectionId: c.connectionId },
      }),
    );
  }
  {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ctx.doc.send(
        new ScanCommand({
          TableName: ctx.tables.agentLocks,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        await ctx.doc.send(
          new DeleteCommand({
            TableName: ctx.tables.agentLocks,
            Key: { agentId: item.agentId },
          }),
        );
      }
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }
  for (const s of await listSchedules(ctx)) {
    await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.schedules, Key: { id: s.id } }));
  }
  for (const r of await listRepositories(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({ TableName: ctx.tables.repositories, Key: { id: r.id } }),
    );
  }
  for (const a of await listArchives(ctx)) {
    await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.archives, Key: { key: a.key } }));
  }
  {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ctx.doc.send(
        new ScanCommand({
          TableName: ctx.tables.sessionLogs,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        await ctx.doc.send(
          new DeleteCommand({
            TableName: ctx.tables.sessionLogs,
            Key: {
              sessionId: item.sessionId,
              timestampSeq: item.timestampSeq,
            },
          }),
        );
      }
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }
}
