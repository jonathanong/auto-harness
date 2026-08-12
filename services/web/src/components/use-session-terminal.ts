import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { DEFAULT_TERMINAL_FONT_SIZE } from "../lib/session-terminal.ts";

type SessionTerminalRuntime = {
  terminal: Terminal;
  search: SearchAddon;
  fit: FitAddon;
  renderedText: string;
};

export function useSessionTerminal(
  hostRef: RefObject<HTMLDivElement | null>,
  text: string,
  fontSize: number,
) {
  const runtimeRef = useRef<SessionTerminalRuntime | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const fit = useCallback(() => {
    try {
      runtimeRef.current?.fit.fit();
    } catch {
      // The host can be temporarily hidden while navigating or entering fullscreen.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
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
      const search = new searchModule.SearchAddon();
      const fitAddon = new fitModule.FitAddon();
      terminal.loadAddon(search);
      terminal.loadAddon(fitAddon);
      terminal.open(hostRef.current);
      runtimeRef.current = { terminal, search, fit: fitAddon, renderedText: textRef.current };
      terminal.write(textRef.current, fit);
      observer = new ResizeObserver(fit);
      observer.observe(hostRef.current);
      fit();
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      runtimeRef.current?.terminal.dispose();
      runtimeRef.current = null;
    };
  }, [fit, hostRef]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.renderedText === text) return;
    const wasAtBottom =
      runtime.terminal.buffer.active.viewportY >= runtime.terminal.buffer.active.baseY;
    if (text.startsWith(runtime.renderedText)) {
      runtime.terminal.write(text.slice(runtime.renderedText.length), () => {
        if (wasAtBottom) runtime.terminal.scrollToBottom();
      });
    } else {
      runtime.terminal.reset();
      runtime.terminal.write(text, () => {
        if (wasAtBottom) runtime.terminal.scrollToBottom();
      });
    }
    runtime.renderedText = text;
  }, [text]);

  useEffect(() => {
    if (runtimeRef.current) {
      runtimeRef.current.terminal.options.fontSize = fontSize;
      fit();
    }
  }, [fit, fontSize]);

  return { fit, runtimeRef };
}
