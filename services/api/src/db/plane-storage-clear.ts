import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { listAllSessions, listAllWorktrees } from "./plane-storage-sessions.ts";
import { listConnections } from "./plane-storage-locks.ts";
import {
  listHostInventories,
  listArchives,
  listRepositories,
  listSchedules,
} from "./plane-storage-catalog.ts";
import { listCommands, listProviders } from "./plane-storage-catalog-providers.ts";
import { listProviderAccounts } from "./plane-storage-provider-accounts.ts";
import { deleteAuthAccount, listAuthAccounts } from "./plane-storage-auth.ts";
import { listAllAuditLogs } from "./plane-storage-audit.ts";
import { getSlackIntegration } from "./plane-storage-integrations.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

/** Test helper: wipe all items in every table (DynamoDB Local). */
export async function clearAll(ctx: PlaneStorageCtx): Promise<void> {
  await clearByKey(ctx, ctx.tables.notificationDeliveries, "id");
  for (const account of await listAuthAccounts(ctx)) {
    await deleteAuthAccount(ctx, account.id);
  }
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
          TableName: ctx.tables.hostLocks,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        await ctx.doc.send(
          new DeleteCommand({
            TableName: ctx.tables.hostLocks,
            Key: { hostId: item.hostId },
          }),
        );
      }
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }
  {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ctx.doc.send(
        new ScanCommand({ TableName: ctx.tables.rateLimits, ExclusiveStartKey: startKey }),
      );
      for (const item of res.Items ?? []) {
        await ctx.doc.send(
          new DeleteCommand({
            TableName: ctx.tables.rateLimits,
            Key: { bucketKey: item.bucketKey },
          }),
        );
      }
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }
  {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ctx.doc.send(
        new ScanCommand({
          TableName: ctx.tables.concurrencyLocks,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        await ctx.doc.send(
          new DeleteCommand({
            TableName: ctx.tables.concurrencyLocks,
            Key: { concurrencyId: item.concurrencyId },
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
  for (const h of await listHostInventories(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({ TableName: ctx.tables.hostInventories, Key: { hostId: h.hostId } }),
    );
  }
  for (const p of await listProviders(ctx)) {
    await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.providers, Key: { id: p.id } }));
  }
  for (const a of await listProviderAccounts(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({ TableName: ctx.tables.providerAccounts, Key: { id: a.id } }),
    );
  }
  for (const c of await listCommands(ctx)) {
    await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.commands, Key: { id: c.id } }));
  }
  for (const audit of await listAllAuditLogs(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.auditLogs,
        Key: { scope: "audit", timestampId: `${audit.createdAt}#${audit.id}` },
      }),
    );
  }
  if (await getSlackIntegration(ctx)) {
    await ctx.doc.send(
      new DeleteCommand({ TableName: ctx.tables.integrations, Key: { id: "slack" } }),
    );
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

async function clearByKey(ctx: PlaneStorageCtx, tableName: string, keyName: string): Promise<void> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }),
    );
    for (const item of result.Items ?? []) {
      await ctx.doc.send(
        new DeleteCommand({ TableName: tableName, Key: { [keyName]: item[keyName] } }),
      );
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
}
