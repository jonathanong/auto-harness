import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LogCategory } from "../lib/session-log-classify.ts";
import { parseLogLineHash, replaceLogLineHash } from "../lib/session-log-hash.ts";
import {
  readSessionLogPretty,
  readSessionLogView,
  storeSessionLogPretty,
  storeSessionLogView,
} from "../lib/session-log-prefs.ts";
import {
  droppedPrefixLineCount,
  parseSessionLogText,
  presentCategories,
  toggleSetValue,
  visibleRecords,
} from "../lib/session-log-records.ts";
import { findRecordMatches, nextMatchIndex, searchResultLabel } from "../lib/session-log-search.ts";

export function useSessionLogState(text: string) {
  const prevTextRef = useRef("");
  const pendingHashRef = useRef(
    parseLogLineHash(typeof location === "undefined" ? "" : location.hash),
  );
  const [lineBase, setLineBase] = useState(0);
  useEffect(() => {
    const dropped = droppedPrefixLineCount(prevTextRef.current, text);
    if (dropped) setLineBase((base) => base + dropped);
    prevTextRef.current = text;
  }, [text]);
  const records = useMemo(() => parseSessionLogText(text, lineBase), [lineBase, text]);
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
    const line = pendingHashRef.current;
    if (!line || !records.some((record) => record.line === line)) return;
    setRawMode(false);
    setSelected(new Set());
    setHighlightedLine(line);
    pendingHashRef.current = undefined;
    requestAnimationFrame(() =>
      document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" }),
    );
  }, [records]);

  useEffect(() => {
    const onHashChange = () => {
      const line = parseLogLineHash(location.hash);
      pendingHashRef.current = line;
      if (!line) return;
      setRawMode(false);
      setSelected(new Set());
      setHighlightedLine(line);
      pendingHashRef.current = undefined;
      requestAnimationFrame(() =>
        document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" }),
      );
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!searched) return;
    if (matches.length === 0) {
      setActiveIndex(-1);
      setSearchResult("No match");
      return;
    }
    setActiveIndex((current) => {
      const next = current >= 0 && current < matches.length ? current : 0;
      setSearchResult(searchResultLabel(matches.length, next, true));
      return next;
    });
  }, [matches, searched]);

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
      pendingHashRef.current = undefined;
      const href = replaceLogLineHash(line);
      const clipboard = navigator.clipboard;
      if (clipboard) void clipboard.writeText(href).catch(() => undefined);
    },
  };
}
