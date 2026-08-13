import { Button } from "@auto-harness/ui";
import type { RefObject } from "react";

export function SessionTerminalControls({
  sessionId,
  searchInputRef,
  query,
  setQuery,
  searchResult,
  search,
  fontSize,
  changeFontSize,
  fullscreen,
  toggleFullscreen,
  download,
}: {
  sessionId: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (value: string) => void;
  searchResult: string;
  search: (direction: "next" | "previous") => void;
  fontSize: number;
  changeFontSize: (delta: number) => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
  download: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-pw="session-terminal-controls">
      <label className="sr-only" htmlFor={`terminal-search-${sessionId}`}>
        Search session logs
      </label>
      <input
        ref={searchInputRef}
        id={`terminal-search-${sessionId}`}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") search(event.shiftKey ? "previous" : "next");
        }}
        placeholder="Search logs (Ctrl+F)"
        className="h-8 min-w-48 rounded-md border bg-background px-2 text-sm"
        data-pw="session-terminal-search"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => search("previous")}
        disabled={!query}
        data-pw="session-terminal-search-previous"
      >
        Previous
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => search("next")}
        disabled={!query}
        data-pw="session-terminal-search-next"
      >
        Next
      </Button>
      <span className="sr-only" aria-live="polite" data-pw="session-terminal-search-result">
        {searchResult}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label="Decrease terminal font size"
        onClick={() => changeFontSize(-1)}
        data-pw="session-terminal-font-decrease"
      >
        A−
      </Button>
      <output className="min-w-10 text-center text-xs" data-pw="session-terminal-font-size">
        {fontSize}px
      </output>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label="Increase terminal font size"
        onClick={() => changeFontSize(1)}
        data-pw="session-terminal-font-increase"
      >
        A+
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={fullscreen}
        onClick={toggleFullscreen}
        data-pw="session-terminal-fullscreen"
      >
        {fullscreen ? "Exit fullscreen" : "Fullscreen"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={download}
        data-pw="session-terminal-download"
      >
        Download .txt
      </Button>
    </div>
  );
}
