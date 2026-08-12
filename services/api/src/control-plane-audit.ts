import { newAuditRecord } from "./audit.ts";
import type {
  AuditLogInput,
  AuditLogListQuery,
  AuditLogPage,
  AuditLogRecord,
} from "./audit-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

function compareRecords(a: AuditLogRecord, b: AuditLogRecord): number {
  const aKey = `${a.createdAt}#${a.id}`;
  const bKey = `${b.createdAt}#${b.id}`;
  return bKey.localeCompare(aKey);
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

function encodeCursor(record: AuditLogRecord): string {
  return Buffer.from(JSON.stringify({ id: record.id, createdAt: record.createdAt })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined): { id: string; createdAt: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof (decoded as { id?: unknown }).id !== "string" ||
      typeof (decoded as { createdAt?: unknown }).createdAt !== "string"
    ) {
      throw new Error("invalid cursor");
    }
    return decoded as { id: string; createdAt: string };
  } catch {
    throw new Error("invalid audit cursor");
  }
}

export async function appendAuditLog(
  state: ControlPlaneState,
  input: AuditLogInput,
): Promise<AuditLogRecord> {
  const record = newAuditRecord(input, state.now(), state.auditIdFactory());
  // State writes elsewhere cannot all share a DynamoDB transaction. The audit
  // append therefore happens before acknowledgement; callers surface a 500 if
  // it fails, making a successfully mutated-but-unaudited request visible for
  // operator recovery rather than silently successful.
  if (state.storage) await state.storage.putAuditLog(record);
  state.auditLogs.set(record.id, record);
  return { ...record, actor: { ...record.actor }, metadata: { ...record.metadata } };
}

export async function listAuditLogs(
  state: ControlPlaneState,
  query: AuditLogListQuery = {},
): Promise<AuditLogPage> {
  if (state.storage) {
    const page = await state.storage.listAuditLogs(query);
    for (const record of page.items) state.auditLogs.set(record.id, record);
    return page;
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const cursor = decodeCursor(query.cursor);
  const sorted = [...state.auditLogs.values()].toSorted(compareRecords);
  const start = cursor
    ? sorted.findIndex(
        (record) => record.id === cursor.id && record.createdAt === cursor.createdAt,
      ) + 1
    : 0;
  if (cursor && start === 0) throw new Error("invalid audit cursor");
  const eligible = sorted.slice(start).filter((record) => matches(record, query));
  const items = eligible.slice(0, limit).map((record) => ({
    ...record,
    actor: { ...record.actor },
    metadata: { ...record.metadata },
  }));
  const hasMore = eligible.length > items.length;
  return { items, ...(hasMore && items.at(-1) ? { nextCursor: encodeCursor(items.at(-1)!) } : {}) };
}
