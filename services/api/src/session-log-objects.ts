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

export function parseGzipJsonlLogs(sessionId: string, gzipped: Buffer): LogRecord[] {
  const text = gunzipToUtf8(gzipped);
  const records: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as {
      timestamp?: unknown;
      stream?: unknown;
      content?: unknown;
      seq?: unknown;
      dropped?: unknown;
    };
    if (
      typeof parsed.timestamp !== "string" ||
      typeof parsed.stream !== "string" ||
      typeof parsed.content !== "string" ||
      typeof parsed.seq !== "number"
    ) {
      continue;
    }
    records.push({
      sessionId,
      timestamp: parsed.timestamp,
      stream: parsed.stream,
      content: parsed.content,
      seq: parsed.seq,
      timestampSeq: formatLogSortKey(parsed.timestamp, parsed.seq),
      ...(typeof parsed.dropped === "number" ? { dropped: parsed.dropped } : {}),
    });
  }
  return records;
}

export function gzipLogRecords(records: readonly LogRecord[]): Buffer {
  return gzipJsonlLines(
    records.map((record) =>
      JSON.stringify({
        timestamp: record.timestamp,
        stream: record.stream,
        content: record.content,
        seq: record.seq,
        ...(record.dropped !== undefined ? { dropped: record.dropped } : {}),
      }),
    ),
  );
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
  const ordered = keys.has(archiveKey)
    ? [archiveKey]
    : [...keys].toSorted((left, right) => left.localeCompare(right));
  const records: LogRecord[] = [];
  for (const key of ordered) {
    const stored = state.logObjects.get(key) ?? (await state.archiveWriter?.getGzipObject?.(key));
    if (!stored) continue;
    records.push(...parseGzipJsonlLogs(sessionId, stored));
  }
  records.sort((left, right) => left.timestampSeq.localeCompare(right.timestampSeq));
  return query ? selectLogs(records, query) : records;
}
