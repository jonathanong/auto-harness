import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { ITheme, Terminal } from "@xterm/xterm";

import { terminalText, type TerminalLogEntry } from "../lib/session-terminal.ts";
import { THEME_CHANGE_EVENT } from "./theme-toggle.tsx";

type SessionTerminalRuntime = {
  terminal: Terminal;
  search: SearchAddon;
  renderedThrough: string | null;
  renderedText: string;
};

/**
 * Reads the live --terminal-* custom properties rather than hardcoding colors, so the panel
 * responds to the light/dark toggle instead of being permanently dark regardless of theme.
 * Falls back to the light-mode literal if a variable is somehow unset (e.g. in a test
 * environment with no stylesheet loaded).
 */
function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value ? `hsl(${value})` : fallback;
  };
  return {
    background: read("--terminal-background", "#090f1f"),
    foreground: read("--terminal-foreground", "#e5e7eb"),
    cursor: read("--terminal-cursor", "#e5e7eb"),
  };
}

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
  items: readonly TerminalLogEntry[],
  text: string,
  fontSize: number,
  enabled: boolean,
) {
  const runtimeRef = useRef<SessionTerminalRuntime | null>(null);
  const fontSizeRef = useRef(fontSize);
  const itemsRef = useRef(items);
  const textRef = useRef(text);
  fontSizeRef.current = fontSize;
  itemsRef.current = items;
  textRef.current = text;
  const refresh = useCallback(() => repaintTerminal(runtimeRef.current), []);

  useEffect(() => {
    if (!enabled) return;
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
          fontSize: fontSizeRef.current,
          screenReaderMode: true,
          scrollback: 10_000,
          theme: readTerminalTheme(),
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
  }, [enabled, hostRef]);

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

  useEffect(() => {
    const onThemeChange = () => {
      if (!runtimeRef.current) return;
      // xterm only picks up a `theme` reassignment on reference change, not mutation —
      // a fresh object is required even though every key is being replaced with itself.
      runtimeRef.current.terminal.options.theme = readTerminalTheme();
      refresh();
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, [refresh]);

  return { refresh, runtimeRef };
}
