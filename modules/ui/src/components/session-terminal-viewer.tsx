"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  adjustedTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  terminalDownloadName,
  terminalShortcut,
  terminalText,
  type TerminalLogEntry,
} from "../lib/session-terminal.ts";
import { SessionLogFilters } from "./session-log-filters.tsx";
import { SessionLogViewer } from "./session-log-viewer.tsx";
import { SessionTerminalControls } from "./session-terminal-controls.tsx";
import { useLogStickBottom } from "./use-log-stick-bottom.ts";
import { useSessionLogState } from "./use-session-log-state.ts";
import { useSessionTerminal } from "./use-session-terminal.ts";

export function SessionTerminalViewer({
  sessionId,
  items,
}: {
  sessionId: string;
  items: TerminalLogEntry[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const text = useMemo(() => terminalText(items), [items]);
  const log = useSessionLogState(text);
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const [fullscreen, setFullscreen] = useState(false);
  const { refresh, runtimeRef } = useSessionTerminal(hostRef, items, text, fontSize, log.rawMode);
  useLogStickBottom(scrollerRef, text, !log.rawMode);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
      requestAnimationFrame(refresh);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [refresh]);

  const search = (direction: "next" | "previous") => {
    if (!log.rawMode) {
      log.searchReadable(direction);
      return;
    }
    const found =
      direction === "next"
        ? runtimeRef.current?.search.findNext(log.query, { caseSensitive: false })
        : runtimeRef.current?.search.findPrevious(log.query, { caseSensitive: false });
    log.setSearchResult(found ? "Match found" : "No match");
  };

  const toggleFullscreen = () => {
    if (fullscreen) {
      setFullscreen(false);
      if (document.fullscreenElement) void document.exitFullscreen();
      return;
    }
    setFullscreen(true);
    void sectionRef.current?.requestFullscreen?.().catch(() => undefined);
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
      ref={sectionRef}
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col gap-2 bg-background p-4"
          : "space-y-2 rounded-md border bg-background p-2"
      }
      data-pw="session-terminal"
      data-fullscreen={fullscreen ? "true" : "false"}
      data-view={log.rawMode ? "raw" : "readable"}
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
        query={log.query}
        setQuery={log.setQuery}
        searchResult={log.searchResult}
        search={search}
        fontSize={fontSize}
        changeFontSize={(delta) =>
          setFontSize((current) => adjustedTerminalFontSize(current, delta))
        }
        fullscreen={fullscreen}
        toggleFullscreen={toggleFullscreen}
        download={download}
        pretty={log.pretty}
        togglePretty={() => log.setPretty(!log.pretty)}
        rawMode={log.rawMode}
        toggleRawMode={() => log.setRawMode(!log.rawMode)}
      />
      {log.rawMode ? null : (
        <SessionLogFilters
          categories={log.categories}
          selected={log.selected}
          onChange={log.setSelected}
        />
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-pw="session-logs-empty">
          No logs yet.
        </p>
      ) : null}
      <pre className="sr-only" aria-live="polite" data-pw="session-terminal-transcript">
        {text}
      </pre>
      {log.rawMode ? (
        <div
          ref={hostRef}
          className={fullscreen ? "min-h-0 flex-1 overflow-auto" : "overflow-x-auto"}
          data-pw="session-logs"
          tabIndex={0}
          aria-label="Read-only ANSI session output"
        />
      ) : items.length === 0 ? null : (
        <SessionLogViewer
          records={log.visible}
          pretty={log.pretty}
          fontSize={fontSize}
          query={log.searched ? log.query : ""}
          activeMatch={log.matches[log.activeIndex]}
          highlightedLine={log.highlightedLine}
          expanded={log.expanded}
          fullscreen={fullscreen}
          scrollerRef={scrollerRef}
          onLineClick={log.onLineClick}
          onToggleExpand={log.toggleExpand}
        />
      )}
    </section>
  );
}
