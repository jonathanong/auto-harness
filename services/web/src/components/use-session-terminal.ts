import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

import type { LiveLogEntry } from "../lib/live-session-logs.ts";
import { DEFAULT_TERMINAL_FONT_SIZE, terminalText } from "../lib/session-terminal.ts";

type SessionTerminalRuntime = {
  terminal: Terminal;
  search: SearchAddon;
  fitAddon: FitAddon;
  renderedThrough: string | null;
  renderedText: string;
};

/**
 * The host can be temporarily hidden (0x0) while navigating or mid-fullscreen-transition,
 * which makes FitAddon's measurement (or a stale-rows repaint) throw — expected, not an error.
 */
function repaintTerminal(runtime: SessionTerminalRuntime | null): void {
  if (!runtime) return;
  try {
    runtime.terminal.refresh(0, runtime.terminal.rows - 1);
  } catch {
    // See doc comment above.
  }
}

/** Resizes the terminal's grid to fill its host element, then repaints. */
function fitTerminal(runtime: SessionTerminalRuntime | null): void {
  if (!runtime) return;
  try {
    runtime.fitAddon.fit();
  } catch {
    // See doc comment above.
    return;
  }
  repaintTerminal(runtime);
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
  const fit = useCallback(() => fitTerminal(runtimeRef.current), []);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([xterm, fitModule, searchModule]) => {
      if (disposed || !hostRef.current) return;
      const terminal = new xterm.Terminal({
        allowTransparency: false,
        convertEol: false,
        cursorBlink: false,
        disableStdin: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: DEFAULT_TERMINAL_FONT_SIZE,
        screenReaderMode: true,
        scrollback: 10_000,
        theme: { background: "#090f1f", foreground: "#e5e7eb", cursor: "#e5e7eb" },
      });
      const fitAddon = new fitModule.FitAddon();
      const search = new searchModule.SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(search);
      terminal.open(hostRef.current);
      const runtime: SessionTerminalRuntime = {
        terminal,
        search,
        fitAddon,
        renderedText: textRef.current,
        renderedThrough: itemsRef.current.at(-1)?.timestampSeq ?? null,
      };
      runtimeRef.current = runtime;
      fitTerminal(runtime);
      terminal.write(textRef.current, () => repaintTerminal(runtime));
      resizeObserver = new ResizeObserver(() => fitTerminal(runtimeRef.current));
      resizeObserver.observe(hostRef.current);
    });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
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
      fit();
    }
  }, [fontSize, fit]);

  return { fit, runtimeRef };
}
