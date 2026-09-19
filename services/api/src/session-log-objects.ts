import {
  formatLogSortKey,
  gunzipToUtf8,
  gzipJsonlLines,
  sessionLogArchiveKey,
  sessionLogPartKey,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { LogQuery, LogRecord } from "./control-plane-types.ts";
import { selectLogs } from "./log-query.ts";

type RawLogLine = {
  timestamp?: unknown;
  stream?: unknown;
  content?: unknown;
  seq?: unknown;
  dropped?: unknown;
};

function toLogRecord(
  sessionId: string,
  parsed: RawLogLine,
  positionalSeq: number,
  requireSeq: boolean,
): LogRecord | null {
  if (
    typeof parsed.timestamp !== "string" ||
    typeof parsed.stream !== "string" ||
    typeof parsed.content !== "string"
  ) {
    return null;
  }
  const hasSeq = typeof parsed.seq === "number";
  if (requireSeq && !hasSeq) return null;
  const seq = hasSeq ? (parsed.seq as number) : positionalSeq;
  return {
    sessionId,
    timestamp: parsed.timestamp,
    stream: parsed.stream,
    content: parsed.content,
    seq,
    timestampSeq: formatLogSortKey(parsed.timestamp, seq),
    ...(typeof parsed.dropped === "number" ? { dropped: parsed.dropped } : {}),
  };
}

function parseGzipJsonl(sessionId: string, gzipped: Buffer, requireSeq: boolean): LogRecord[] {
  const text = gunzipToUtf8(gzipped);
  const records: LogRecord[] = [];
  let position = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as RawLogLine;
    const record = toLogRecord(sessionId, parsed, position, requireSeq);
    if (!record) continue;
    records.push(record);
    position += 1;
  }
  return records;
}

/**
 * Strict: every line must carry the real, agent-assigned numeric `seq` (Invariant 5). Used for
 * gzip log *parts* (`assertGzipJsonlPart`'s declared-range check depends on the real value) and
 * for the structural validation on a host-uploaded archive (`putSessionLogArchive`).
 */
export function parseGzipJsonlLogs(sessionId: string, gzipped: Buffer): LogRecord[] {
  return parseGzipJsonl(sessionId, gzipped, true);
}

/**
 * Lenient: only for the whole-session terminal archive object. Archives written before `seq`
 * was added to the archive record format (see `archiveBody` in control-plane-archive.ts) have
 * no numeric `seq` per line. Assign one deterministically from each record's position in the
 * file -- already in chronological order -- so those pre-existing archives read back instead of
 * silently parsing to zero records. Never used for log *parts*: those keep the strict,
 * host-declared `seq` requirement above.
 */
function parseArchiveLogRecords(sessionId: string, gzipped: Buffer): LogRecord[] {
  return parseGzipJsonl(sessionId, gzipped, false);
}

export function serializeLogRecordLine(record: {
  timestamp: string;
  stream: string;
  content: string;
  seq: number;
  dropped?: number;
}): string {
  return JSON.stringify({
    timestamp: record.timestamp,
    stream: record.stream,
    content: record.content,
    seq: record.seq,
    ...(record.dropped !== undefined ? { dropped: record.dropped } : {}),
  });
}

export function gzipLogRecords(records: readonly LogRecord[]): Buffer {
  return gzipJsonlLines(records.map(serializeLogRecordLine));
}

export async function putSessionLogPart(
  state: ControlPlaneState,
  sessionId: string,
  seqStart: number,
  seqEnd: number,
  gzipped: Buffer,
): Promise<string> {
  assertGzipJsonlPart(sessionId, seqStart, seqEnd, gzipped);
  const key = sessionLogPartKey(sessionId, seqStart, seqEnd);
  if (!state.archiveWriter?.putGzipObject) state.logObjects.set(key, gzipped);
  await state.archiveWriter?.putGzipObject?.(key, gzipped);
  state.onLogPartCommitted?.({ sessionId, key, seqStart, seqEnd });
  return key;
}

export async function putSessionLogArchive(
  state: ControlPlaneState,
  sessionId: string,
  gzipped: Buffer,
): Promise<string> {
  parseGzipJsonlLogs(sessionId, gzipped);
  const key = sessionLogArchiveKey(sessionId);
  if (!state.archiveWriter?.putGzipObject) state.logObjects.set(key, gzipped);
  await state.archiveWriter?.putGzipObject?.(key, gzipped);
  return key;
}

function assertGzipJsonlPart(
  sessionId: string,
  seqStart: number,
  seqEnd: number,
  gzipped: Buffer,
): void {
  const records = parseGzipJsonlLogs(sessionId, gzipped);
  if (records.length === 0) throw new Error("empty log part");
  for (const record of records) {
    if (record.seq < seqStart || record.seq > seqEnd) throw new Error("seq outside declared range");
  }
}

export async function readSessionLogObjects(
  state: ControlPlaneState,
  sessionId: string,
  query?: LogQuery,
): Promise<LogRecord[] | undefined> {
  const prefix = `sessions/${sessionId}/`;
  const keys = new Set([...state.logObjects.keys()].filter((key) => key.startsWith(prefix)));
  const listed = await state.archiveWriter?.listKeys?.(prefix);
  for (const key of listed ?? []) keys.add(key);
  if (keys.size === 0) return undefined;
  const archiveKey = sessionLogArchiveKey(sessionId);
  if (keys.has(archiveKey)) {
    const archived =
      state.logObjects.get(archiveKey) ?? (await state.archiveWriter?.getGzipObject?.(archiveKey));
    if (archived) {
      const records = parseArchiveLogRecords(sessionId, archived);
      records.sort((left, right) => left.timestampSeq.localeCompare(right.timestampSeq));
      return query ? selectLogs(records, query) : records;
    }
    keys.delete(archiveKey);
    if (keys.size === 0) return undefined;
  }
  const ordered = [...keys].toSorted((left, right) => left.localeCompare(right));
  const records: LogRecord[] = [];
  for (const key of ordered) {
    const stored = state.logObjects.get(key) ?? (await state.archiveWriter?.getGzipObject?.(key));
    if (!stored) continue;
    records.push(...parseGzipJsonlLogs(sessionId, stored));
  }
  records.sort((left, right) => left.timestampSeq.localeCompare(right.timestampSeq));
  return query ? selectLogs(records, query) : records;
}
