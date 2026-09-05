import { stripAnsi } from "./session-log-ansi.ts";
import { classifyLogLine, LOG_CATEGORIES, type LogCategory } from "./session-log-classify.ts";

export type SessionLogRecord = {
  line: number;
  raw: string;
  category: LogCategory;
  typeLabel: string;
  preview: string;
  json: unknown | undefined;
};

const COLLAPSE_CHAR_THRESHOLD = 500;
const COLLAPSE_LINE_THRESHOLD = 8;

export function foldCarriageReturnLine(line: string): string {
  if (!line.includes("\r")) return line;
  let result = "";
  for (const part of line.split("\r")) {
    const visiblePart = stripAnsi(part).length;
    const visibleResult = stripAnsi(result).length;
    result = visiblePart >= visibleResult ? part : part + stripAnsi(result).slice(visiblePart);
  }
  return result;
}

export function splitLogText(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(foldCarriageReturnLine);
}

export function droppedPrefixLineCount(previousText: string, nextText: string): number {
  if (!previousText || previousText === nextText || nextText.length >= previousText.length) {
    return 0;
  }
  if (!previousText.endsWith(nextText)) return 0;
  return splitLogText(previousText.slice(0, previousText.length - nextText.length)).length;
}

export function parseSessionLogText(text: string, lineBase = 0): SessionLogRecord[] {
  return splitLogText(text).map((raw, index) => ({
    line: lineBase + index + 1,
    raw,
    ...classifyLogLine(raw),
  }));
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function recordDisplayText(record: SessionLogRecord, pretty: boolean): string {
  if (record.json !== undefined && pretty) return prettyJson(record.json);
  return record.preview || record.raw;
}

export function shouldCollapse(text: string): boolean {
  if (text.length > COLLAPSE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (const ch of text) {
    if (ch === "\n" && ++lines > COLLAPSE_LINE_THRESHOLD) return true;
  }
  return false;
}

export function truncateDisplay(text: string): string {
  const lines = text.split("\n");
  if (lines.length > COLLAPSE_LINE_THRESHOLD) {
    return lines.slice(0, COLLAPSE_LINE_THRESHOLD).join("\n");
  }
  return text.length > COLLAPSE_CHAR_THRESHOLD ? text.slice(0, COLLAPSE_CHAR_THRESHOLD) : text;
}

export function visibleRecords(
  records: readonly SessionLogRecord[],
  selected: ReadonlySet<LogCategory>,
): SessionLogRecord[] {
  if (selected.size === 0) return [...records];
  return records.filter((record) => selected.has(record.category));
}

export function presentCategories(records: readonly SessionLogRecord[]): LogCategory[] {
  const seen = new Set<LogCategory>();
  for (const record of records) seen.add(record.category);
  return LOG_CATEGORIES.filter((category) => seen.has(category));
}

export function toggleSetValue<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
