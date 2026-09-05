import { stripAnsi } from "./session-log-ansi.ts";
import { recordDisplayText, type SessionLogRecord } from "./session-log-records.ts";

export type SearchMatch = {
  line: number;
  start: number;
  end: number;
};

export type TextMark = { text: string; kind: "plain" | "match" | "active" };

export function findTextMatches(
  text: string,
  query: string,
): Array<{ start: number; end: number }> {
  const needle = query.trim();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const find = needle.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= haystack.length - find.length) {
    const start = haystack.indexOf(find, from);
    if (start < 0) break;
    matches.push({ start, end: start + find.length });
    from = start + find.length;
  }
  return matches;
}

export function findRecordMatches(
  records: readonly SessionLogRecord[],
  query: string,
  pretty: boolean,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const record of records) {
    const text = stripAnsi(recordDisplayText(record, pretty));
    for (const span of findTextMatches(text, query)) {
      matches.push({ line: record.line, start: span.start, end: span.end });
    }
  }
  return matches;
}

export function searchResultLabel(
  matchCount: number,
  activeIndex: number,
  searched: boolean,
): string {
  if (!searched) return "";
  if (matchCount === 0) return "No match";
  return `${activeIndex + 1} of ${matchCount}`;
}

export function nextMatchIndex(
  count: number,
  current: number,
  direction: "next" | "previous",
): number {
  if (count === 0) return 0;
  if (current < 0) return direction === "next" ? 0 : count - 1;
  if (direction === "next") return (current + 1) % count;
  return (current - 1 + count) % count;
}

export function markSearchText(text: string, query: string, activeStart?: number): TextMark[] {
  const spans = findTextMatches(text, query);
  if (spans.length === 0) return [{ text, kind: "plain" }];
  const marks: TextMark[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) marks.push({ text: text.slice(cursor, span.start), kind: "plain" });
    marks.push({
      text: text.slice(span.start, span.end),
      kind: span.start === activeStart ? "active" : "match",
    });
    cursor = span.end;
  }
  const rest = text.slice(cursor);
  if (rest) marks.push({ text: rest, kind: "plain" });
  return marks;
}
