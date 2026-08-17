"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { LiveLogEntry } from "../lib/live-session-logs.ts";
import {
  adjustedTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  terminalDownloadName,
  terminalShortcut,
  terminalText,
} from "../lib/session-terminal.ts";
import { SessionTerminalControls } from "./session-terminal-controls.tsx";
import { useSessionTerminal } from "./use-session-terminal.ts";

export function SessionTerminalViewer({
  sessionId,
  items,
}: {
  sessionId: string;
  items: LiveLogEntry[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const text = useMemo(() => terminalText(items), [items]);
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const [fullscreen, setFullscreen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState("Search logs");

  const { refresh, runtimeRef } = useSessionTerminal(hostRef, items, text, fontSize);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
      requestAnimationFrame(refresh);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [refresh]);

  const search = (direction: "next" | "previous") => {
    const found =
      direction === "next"
        ? runtimeRef.current?.search.findNext(query, { caseSensitive: false })
        : runtimeRef.current?.search.findPrevious(query, { caseSensitive: false });
    setSearchResult(found ? "Match found" : "No match");
  };

  const toggleFullscreen = () => {
    if (fullscreen) {
      setFullscreen(false);
      if (document.fullscreenElement) void document.exitFullscreen();
      return;
    }
    setFullscreen(true);
    void hostRef.current?.parentElement?.requestFullscreen?.().catch(() => undefined);
    requestAnimationFrame(refresh);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = terminalDownloadName(sessionId);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col gap-2 bg-background p-4"
          : "space-y-2 rounded-md border bg-background p-2"
      }
      data-pw="session-terminal"
      data-fullscreen={fullscreen ? "true" : "false"}
      aria-label="Session terminal log viewer"
      onKeyDownCapture={(event) => {
        const shortcut = terminalShortcut(event.nativeEvent);
        if (!shortcut) return;
        event.preventDefault();
        event.stopPropagation();
        if (shortcut === "search") searchInputRef.current?.focus();
        if (shortcut === "font-increase") {
          setFontSize((current) => adjustedTerminalFontSize(current, 1));
        }
        if (shortcut === "font-decrease") {
          setFontSize((current) => adjustedTerminalFontSize(current, -1));
        }
      }}
    >
      <SessionTerminalControls
        sessionId={sessionId}
        searchInputRef={searchInputRef}
        query={query}
        setQuery={setQuery}
        searchResult={searchResult}
        search={search}
        fontSize={fontSize}
        changeFontSize={(delta) =>
          setFontSize((current) => adjustedTerminalFontSize(current, delta))
        }
        fullscreen={fullscreen}
        toggleFullscreen={toggleFullscreen}
        download={download}
      />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-pw="session-logs-empty">
          No logs yet.
        </p>
      ) : null}
      <pre className="sr-only" aria-live="polite" data-pw="session-terminal-transcript">
        {text}
      </pre>
      <div
        ref={hostRef}
        className={fullscreen ? "min-h-0 flex-1 overflow-auto" : "overflow-x-auto"}
        data-pw="session-logs"
        aria-label="Read-only ANSI session output"
      />
    </section>
  );
}
