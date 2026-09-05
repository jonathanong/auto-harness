import { useCallback, useEffect, useMemo, useState } from "react";

import type { LogCategory } from "../lib/session-log-classify.ts";
import { parseLogLineHash, replaceLogLineHash } from "../lib/session-log-hash.ts";
import {
  readSessionLogPretty,
  readSessionLogView,
  storeSessionLogPretty,
  storeSessionLogView,
} from "../lib/session-log-prefs.ts";
import {
  parseSessionLogText,
  presentCategories,
  toggleSetValue,
  visibleRecords,
} from "../lib/session-log-records.ts";
import { findRecordMatches, nextMatchIndex, searchResultLabel } from "../lib/session-log-search.ts";

export function useSessionLogState(text: string) {
  const records = useMemo(() => parseSessionLogText(text), [text]);
  const [rawMode, setRawMode] = useState(false);
  const [pretty, setPretty] = useState(true);
  const [selected, setSelected] = useState<Set<LogCategory>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [highlightedLine, setHighlightedLine] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searched, setSearched] = useState(false);
  const categories = useMemo(() => presentCategories(records), [records]);
  const visible = useMemo(() => visibleRecords(records, selected), [records, selected]);
  const matches = useMemo(
    () => findRecordMatches(visible, query, pretty),
    [visible, query, pretty],
  );

  useEffect(() => {
    setPretty(readSessionLogPretty());
    if (!parseLogLineHash(location.hash)) setRawMode(readSessionLogView() === "raw");
  }, []);

  useEffect(() => {
    const apply = () => {
      const line = parseLogLineHash(location.hash);
      if (!line) return;
      setRawMode(false);
      setSelected(new Set());
      setHighlightedLine(line);
      requestAnimationFrame(() =>
        document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" }),
      );
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [records]);

  const searchReadable = useCallback(
    (direction: "next" | "previous") => {
      if (!query.trim()) return;
      setSearched(true);
      if (matches.length === 0) {
        setActiveIndex(-1);
        setSearchResult("No match");
        return;
      }
      const next = nextMatchIndex(matches.length, activeIndex, direction);
      const match = matches[next]!;
      setActiveIndex(next);
      setSearchResult(searchResultLabel(matches.length, next, true));
      setExpanded((current) => new Set(current).add(match.line));
      requestAnimationFrame(() =>
        document.getElementById(`L${match.line}`)?.scrollIntoView({ block: "center" }),
      );
    },
    [activeIndex, matches, query],
  );

  return {
    records,
    visible,
    categories,
    matches,
    rawMode,
    pretty,
    selected,
    expanded,
    highlightedLine,
    query,
    searchResult,
    activeIndex,
    searched,
    setQuery: (value: string) => {
      setQuery(value);
      setSearched(false);
      setActiveIndex(-1);
      setSearchResult("");
    },
    setSearchResult,
    searchReadable,
    setRawMode: (next: boolean) => {
      setRawMode(next);
      storeSessionLogView(next ? "raw" : "readable");
    },
    setPretty: (next: boolean) => {
      setPretty(next);
      storeSessionLogPretty(next);
    },
    setSelected,
    toggleExpand: (line: number) => setExpanded((current) => toggleSetValue(current, line)),
    onLineClick: (line: number) => {
      setHighlightedLine(line);
      const href = replaceLogLineHash(line);
      const clipboard = navigator.clipboard;
      if (clipboard) void clipboard.writeText(href).catch(() => undefined);
    },
  };
}
