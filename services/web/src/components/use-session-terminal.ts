import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

import type { LiveLogEntry } from "../lib/live-session-logs.ts";
import { DEFAULT_TERMINAL_FONT_SIZE, terminalText } from "../lib/session-terminal.ts";

type SessionTerminalRuntime = {
  terminal: Terminal;
  search: SearchAddon;
  renderedThrough: string | null;
  renderedText: string;
};

/**
 * The host can be temporarily hidden (0x0) while navigating or mid-fullscreen-transition,
 * which makes a repaint throw — expected, not an error.
 */
function repaintTerminal(runtime: SessionTerminalRuntime | null): void {
  if (!runtime) return;
  try {
    runtime.terminal.refresh(0, runtime.terminal.rows - 1);
  } catch {
    // See doc comment above.
  }
}

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
  const refresh = useCallback(() => repaintTerminal(runtimeRef.current), []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-search")]).then(
      ([xterm, searchModule]) => {
        if (disposed || !hostRef.current) return;
        const terminal = new xterm.Terminal({
          allowTransparency: false,
          convertEol: false,
          cols: 120,
          rows: 40,
          cursorBlink: false,
          disableStdin: true,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: DEFAULT_TERMINAL_FONT_SIZE,
          screenReaderMode: true,
          scrollback: 10_000,
          theme: { background: "#090f1f", foreground: "#e5e7eb", cursor: "#e5e7eb" },
        });
        const search = new searchModule.SearchAddon();
        terminal.loadAddon(search);
        terminal.open(hostRef.current);
        const runtime: SessionTerminalRuntime = {
          terminal,
          search,
          renderedText: textRef.current,
          renderedThrough: itemsRef.current.at(-1)?.timestampSeq ?? null,
        };
        runtimeRef.current = runtime;
        terminal.write(textRef.current, () => repaintTerminal(runtime));
      },
    );
    return () => {
      disposed = true;
      runtimeRef.current?.terminal.dispose();
      runtimeRef.current = null;
    };
  }, [hostRef]);

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
          ? terminalText(appended, runtime.renderedText)
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

  return { refresh, runtimeRef };
}
