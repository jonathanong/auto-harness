import type { RefObject } from "react";

import type { SearchMatch } from "../lib/session-log-search.ts";
import type { SessionLogRecord } from "../lib/session-log-records.ts";
import { SessionLogRow } from "./session-log-row.tsx";

export function SessionLogViewer({
  records,
  pretty,
  fontSize,
  query,
  activeMatch,
  highlightedLine,
  expanded,
  fullscreen,
  scrollerRef,
  onLineClick,
  onToggleExpand,
}: {
  records: readonly SessionLogRecord[];
  pretty: boolean;
  fontSize: number;
  query: string;
  activeMatch?: SearchMatch;
  highlightedLine?: number;
  expanded: ReadonlySet<number>;
  fullscreen: boolean;
  scrollerRef: RefObject<HTMLDivElement | null>;
  onLineClick: (line: number) => void;
  onToggleExpand: (line: number) => void;
}) {
  const gutterCh = String(records.at(-1)?.line ?? 1).length + 1;
  return (
    <div
      ref={scrollerRef}
      className={
        fullscreen
          ? "min-h-0 w-full min-w-0 flex-1 overflow-auto bg-terminal text-terminal-foreground"
          : "max-h-[70vh] w-full min-w-0 overflow-auto bg-terminal text-terminal-foreground"
      }
      data-pw="session-logs"
      aria-label="Session logs"
      style={{ fontSize }}
    >
      {records.map((record) => (
        <SessionLogRow
          key={record.line}
          record={record}
          pretty={pretty}
          query={query}
          activeStart={activeMatch?.line === record.line ? activeMatch.start : undefined}
          highlighted={highlightedLine === record.line}
          expanded={expanded.has(record.line)}
          gutterCh={gutterCh}
          onLineClick={onLineClick}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </div>
  );
}
