import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

import type { LiveLogEntry } from "../lib/live-session-logs.ts";
import { DEFAULT_TERMINAL_FONT_SIZE } from "../lib/session-terminal.ts";

type SessionTerminalRuntime = {
  terminal: Terminal;
  search: SearchAddon;
  renderedThrough: string | null;
  renderedText: string;
};

export function useSessionTerminal(
  hostRef: RefObject<HTMLDivElement | null>,
  items: readonly LiveLogEntry[],
  text: string,
  fontSize: number,
) {
  const runtimeRef = useRef<SessionTerminalRuntime | null>(null);
  const itemsRef = useRef(items);
  const textRef = useRef(text);
  itemsRef.current = items;
  textRef.current = text;
  const refresh = useCallback(() => {
    try {
      const terminal = runtimeRef.current?.terminal;
      if (terminal) terminal.refresh(0, terminal.rows - 1);
    } catch {
      // The host can be temporarily hidden while navigating or entering fullscreen.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-search")]).then(
      ([xterm, searchModule]) => {
        if (disposed || !hostRef.current) return;
        const terminal = new xterm.Terminal({
          allowTransparency: false,
          convertEol: false,
          cursorBlink: false,
          cols: 120,
          disableStdin: true,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: DEFAULT_TERMINAL_FONT_SIZE,
          rows: 40,
          screenReaderMode: true,
          scrollback: 10_000,
          theme: { background: "#090f1f", foreground: "#e5e7eb", cursor: "#e5e7eb" },
        });
        const search = new searchModule.SearchAddon();
        terminal.loadAddon(search);
        terminal.open(hostRef.current);
        runtimeRef.current = {
          terminal,
          search,
          renderedText: textRef.current,
          renderedThrough: itemsRef.current.at(-1)?.timestampSeq ?? null,
        };
        terminal.write(textRef.current, refresh);
      },
    );
    return () => {
      disposed = true;
      runtimeRef.current?.terminal.dispose();
      runtimeRef.current = null;
    };
  }, [hostRef, refresh]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.renderedText === text) return;
    const wasAtBottom =
      runtime.terminal.buffer.active.viewportY >= runtime.terminal.buffer.active.baseY;
    const previousIndex = runtime.renderedThrough
      ? items.findIndex((item) => item.timestampSeq === runtime.renderedThrough)
      : -1;
    const appended = previousIndex >= 0 ? items.slice(previousIndex + 1) : [];
    if (appended.length > 0 || text.startsWith(runtime.renderedText)) {
      const suffix =
        appended.length > 0
          ? appended.map((item) => item.content).join("")
          : text.slice(runtime.renderedText.length);
      runtime.terminal.write(suffix, () => {
        if (wasAtBottom) runtime.terminal.scrollToBottom();
      });
    } else {
      runtime.terminal.reset();
      runtime.terminal.write(text, () => {
        if (wasAtBottom) runtime.terminal.scrollToBottom();
      });
    }
    runtime.renderedText = text;
    runtime.renderedThrough = items.at(-1)?.timestampSeq ?? null;
  }, [items, text]);

  useEffect(() => {
    if (runtimeRef.current) {
      runtimeRef.current.terminal.options.fontSize = fontSize;
      refresh();
    }
  }, [fontSize, refresh]);

  return { fit: refresh, runtimeRef };
}
