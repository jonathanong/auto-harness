import type { LogCategory } from "../lib/session-log-classify.ts";
import {
  recordDisplayText,
  shouldCollapse,
  type SessionLogRecord,
} from "../lib/session-log-records.ts";
import { cn } from "../lib/utils.ts";
import { Badge, type BadgeProps } from "./badge.tsx";
import { SessionLogBody } from "./session-log-body.tsx";

const BADGE: Record<LogCategory, BadgeProps["variant"]> = {
  message: "info",
  thinking: "secondary",
  tool: "warning",
  event: "outline",
  error: "danger",
  system: "success",
  output: "outline",
  other: "secondary",
};

const BORDER: Record<LogCategory, string> = {
  message: "border-info",
  thinking: "border-muted-foreground/50",
  tool: "border-warning",
  event: "border-border",
  error: "border-danger",
  system: "border-success",
  output: "border-border",
  other: "border-muted-foreground/50",
};

export function SessionLogRow({
  record,
  pretty,
  query,
  activeStart,
  highlighted,
  expanded,
  gutterCh,
  onLineClick,
  onToggleExpand,
}: {
  record: SessionLogRecord;
  pretty: boolean;
  query: string;
  activeStart?: number | undefined;
  highlighted: boolean;
  expanded: boolean;
  gutterCh: number;
  onLineClick: (line: number) => void;
  onToggleExpand: (line: number) => void;
}) {
  const collapsible = shouldCollapse(recordDisplayText(record, pretty));
  const collapsed = collapsible && !expanded;
  return (
    <div
      id={`L${record.line}`}
      data-pw={`session-log-line-${record.line}`}
      data-category={record.category}
      data-highlighted={highlighted ? "true" : "false"}
      className={cn(
        "flex gap-3 border-l-2 px-2 py-1",
        BORDER[record.category],
        highlighted ? "bg-yellow-300/10" : undefined,
      )}
    >
      <a
        href={`#L${record.line}`}
        className="shrink-0 pt-0.5 text-right font-mono text-xs text-terminal-foreground/50 hover:text-terminal-foreground"
        style={{ minWidth: `${gutterCh}ch` }}
        data-pw={`session-log-line-link-${record.line}`}
        title={`Copy link to line ${record.line}`}
        onClick={(event) => {
          event.preventDefault();
          onLineClick(record.line);
        }}
      >
        {record.line}
      </a>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant={BADGE[record.category]} className="px-1.5 py-0 text-[10px]">
            {record.category}
          </Badge>
          {record.typeLabel !== record.category ? (
            <span className="font-mono text-xs text-terminal-foreground/60">
              {record.typeLabel}
            </span>
          ) : null}
        </div>
        <pre className="m-0 whitespace-pre-wrap break-words font-mono">
          <SessionLogBody
            record={record}
            pretty={pretty}
            query={query}
            activeStart={activeStart}
            collapsed={collapsed}
          />
        </pre>
        {collapsible ? (
          <button
            type="button"
            className="mt-1 text-xs underline"
            data-pw={`session-log-expand-${record.line}`}
            onClick={() => onToggleExpand(record.line)}
          >
            {collapsed ? "Show more" : "Show less"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
