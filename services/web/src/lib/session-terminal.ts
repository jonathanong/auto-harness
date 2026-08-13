import type { LiveLogEntry } from "./live-session-logs.ts";

export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;

export function terminalText(items: readonly LiveLogEntry[]): string {
  return [...items]
    .toSorted((left, right) => left.timestampSeq.localeCompare(right.timestampSeq))
    .map((item) => item.content)
    .join("");
}

export function adjustedTerminalFontSize(current: number, delta: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, current + delta));
}

export function terminalDownloadName(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-") || "session";
  return `${safeId}.txt`;
}

type TerminalShortcut = "search" | "font-increase" | "font-decrease" | null;

export function terminalShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "key">,
): TerminalShortcut {
  if (!event.ctrlKey && !event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (key === "f") return "search";
  if (key === "+" || key === "=") return "font-increase";
  if (key === "-") return "font-decrease";
  return null;
}
