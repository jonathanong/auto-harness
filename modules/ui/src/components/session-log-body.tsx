import { stripAnsi } from "../lib/session-log-ansi.ts";
import {
  recordDisplayText,
  truncateDisplay,
  type SessionLogRecord,
} from "../lib/session-log-records.ts";
import { AnsiText, MarkedText } from "./session-log-ansi-text.tsx";

export function SessionLogBody({
  record,
  pretty,
  query,
  activeStart,
  collapsed,
}: {
  record: SessionLogRecord;
  pretty: boolean;
  query: string;
  activeStart?: number | undefined;
  collapsed: boolean;
}) {
  const display = recordDisplayText(record, pretty);
  const text = collapsed ? truncateDisplay(display) : display;
  if (query.trim()) {
    return <MarkedText text={stripAnsi(text)} query={query} activeStart={activeStart} />;
  }
  if (record.json === undefined) return <AnsiText text={text} />;
  return text;
}
