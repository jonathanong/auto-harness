import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import type { AuditLogListQuery, AuditLogPage, AuditLogRecord } from "../audit-types.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const AUDIT_SCOPE = "audit";
const MAX_LIST_LIMIT = 100;

type AuditItem = AuditLogRecord & { scope: string; timestampId: string };

function timestampId(record: AuditLogRecord): string {
  return `${record.createdAt}#${record.id}`;
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      (decoded as { scope?: unknown }).scope !== AUDIT_SCOPE ||
      typeof (decoded as { timestampId?: unknown }).timestampId !== "string"
    ) {
      throw new Error("invalid cursor");
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error("invalid audit cursor");
  }
}

function matches(record: AuditLogRecord, query: AuditLogListQuery): boolean {
  return (
    (query.actorId === undefined || record.actor.id === query.actorId) &&
    (query.action === undefined || record.action === query.action) &&
    (query.resourceType === undefined || record.resourceType === query.resourceType) &&
    (query.resourceId === undefined || record.resourceId === query.resourceId) &&
    (query.repositoryId === undefined || record.repositoryId === query.repositoryId) &&
    (query.outcome === undefined || record.outcome === query.outcome)
  );
}

export function auditLogItem(record: AuditLogRecord): AuditItem {
  return { ...record, scope: AUDIT_SCOPE, timestampId: timestampId(record) };
}

function fromItem(item: AuditItem): AuditLogRecord {
  const { scope: _scope, timestampId: _timestampId, ...record } = item;
  return record;
}

export async function putAuditLog(ctx: PlaneStorageCtx, record: AuditLogRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.auditLogs,
      Item: auditLogItem(record),
      ConditionExpression: "attribute_not_exists(#scope) AND attribute_not_exists(timestampId)",
      ExpressionAttributeNames: { "#scope": "scope" },
    }),
  );
}

/** Query the append-only audit partition, consuming nonmatching pages before
 * returning an opaque resume cursor. This preserves filters across restarts
 * without exposing DynamoDB keys to API clients. */
export async function listAuditLogs(
  ctx: PlaneStorageCtx,
  query: AuditLogListQuery = {},
): Promise<AuditLogPage> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_LIST_LIMIT);
  const items: AuditLogRecord[] = [];
  let startKey = decodeCursor(query.cursor);
  do {
    const page = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.auditLogs,
        KeyConditionExpression: "#scope = :scope",
        ExpressionAttributeNames: { "#scope": "scope" },
        ExpressionAttributeValues: { ":scope": AUDIT_SCOPE },
        ScanIndexForward: false,
        Limit: Math.max(limit * 2, 25),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    const pageItems = (page.Items ?? []) as AuditItem[];
    for (const [index, item] of pageItems.entries()) {
      const record = fromItem(item);
      if (!matches(record, query)) continue;
      items.push(record);
      if (items.length === limit) {
        // Query pages can contain more matching records than the caller asked
        // for. Resume after the final returned item, not LastEvaluatedKey, or
        // rows later in this physical page would be skipped forever.
        return {
          items,
          ...(page.LastEvaluatedKey || index < pageItems.length - 1
            ? {
                nextCursor: encodeCursor({
                  scope: AUDIT_SCOPE,
                  timestampId: timestampId(record),
                }),
              }
            : {}),
        };
      }
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (items.length < limit && startKey);
  return { items };
}

export async function listAllAuditLogs(ctx: PlaneStorageCtx): Promise<AuditLogRecord[]> {
  const records: AuditLogRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAuditLogs(ctx, { limit: MAX_LIST_LIMIT, ...(cursor ? { cursor } : {}) });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}
