import {
  LOG_STREAMS,
  type LogQuery,
  type LogRecord,
  type LogStream,
} from "./db/plane-storage-types.ts";

const DEFAULT_LOG_QUERY_LIMIT = 1_000;
const MAX_LOG_QUERY_LIMIT = 10_000;

type LogQueryParseResult = { ok: true; query: LogQuery } | { ok: false; error: string };

function normalizeSince(value: string): string | null {
  // Require an ISO date-time with an explicit zone; Date.parse alone accepts
  // non-ISO strings and silently rolls invalid calendar dates forward.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isLogStream(value: string): value is LogStream {
  return (LOG_STREAMS as readonly string[]).includes(value);
}

/** Parse the public, bounded historical-log REST query contract. */
export function parseLogQuery(searchParams: URLSearchParams): LogQueryParseResult {
  const streamValue = searchParams.get("stream");
  if (streamValue !== null && !isLogStream(streamValue)) {
    return { ok: false, error: "stream must be stdout, stderr, or system" };
  }

  const sinceValue = searchParams.get("since");
  const since = sinceValue === null ? undefined : normalizeSince(sinceValue);
  if (sinceValue !== null && since === null) {
    return { ok: false, error: "since must be an ISO 8601 timestamp with an explicit timezone" };
  }

  const limitValue = searchParams.get("limit");
  const limit = limitValue === null ? DEFAULT_LOG_QUERY_LIMIT : Number(limitValue);
  if (
    (limitValue !== null && !/^[1-9]\d*$/.test(limitValue)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOG_QUERY_LIMIT
  ) {
    return {
      ok: false,
      error: `limit must be an integer from 1 to ${MAX_LOG_QUERY_LIMIT}`,
    };
  }

  return {
    ok: true,
    query: {
      ...(streamValue !== null ? { stream: streamValue } : {}),
      ...(since !== undefined ? { since } : {}),
      limit,
    },
  };
}

/**
 * Filter before applying the limit, then impose the durable timestampSeq
 * order. This is shared by in-memory reads and the defensive storage result
 * ordering so callers see one contract before a future archive reader exists.
 */
export function selectLogs(records: LogRecord[], query: LogQuery): LogRecord[] {
  const afterSortKey = query.since ? `${query.since}\uffff` : undefined;
  return records
    .filter(
      (record) =>
        (query.stream === undefined || record.stream === query.stream) &&
        (afterSortKey === undefined || record.timestampSeq > afterSortKey),
    )
    .toSorted((left, right) => left.timestampSeq.localeCompare(right.timestampSeq))
    .slice(0, query.limit)
    .map((record) => ({ ...record }));
}
