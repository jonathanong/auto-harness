"use client";

import { useState } from "react";

/** Safe-text prompt preview with an accessible full-text disclosure. */
export function SessionPrompt({
  sessionId,
  prompt,
}: {
  sessionId: string;
  prompt?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (prompt == null) {
    return <span data-pw="session-prompt">—</span>;
  }
  const firstBreak = prompt.search(/\r\n|\r|\n/);
  const hasMore = firstBreak >= 0;
  const firstLine = hasMore ? prompt.slice(0, firstBreak) : prompt;
  const contentId = `session-prompt-${encodeURIComponent(sessionId)}`;

  return (
    <div className="min-w-0 space-y-1">
      <span
        id={contentId}
        className={expanded ? "block whitespace-pre-wrap break-words" : "block truncate"}
        data-pw="session-prompt"
      >
        {expanded ? prompt : firstLine}
      </span>
      {hasMore ? (
        <button
          type="button"
          className="text-xs text-primary underline-offset-4 hover:underline"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={`${expanded ? "Collapse" : "Expand"} prompt for session ${sessionId}`}
          data-pw="session-prompt-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show first line" : "Show full prompt"}
        </button>
      ) : null}
    </div>
  );
}
