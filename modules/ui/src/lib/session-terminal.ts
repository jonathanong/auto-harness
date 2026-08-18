export type TerminalLogEntry = {
  timestampSeq: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};

export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;

function terminalEntryText(item: TerminalLogEntry, startsAtLineBoundary = true): string {
  if (item.stream !== "system") return item.content;
  const boundary = startsAtLineBoundary ? "" : "\r\n";
  return `${boundary}[system] ${item.content.replace(/\r?\n$/, "")}\r\n`;
}

export function terminalText(items: readonly TerminalLogEntry[], precedingText = ""): string {
  let startsAtLineBoundary = precedingText.length === 0 || /[\r\n]$/.test(precedingText);
  let text = "";
  for (const item of items.toSorted((left, right) =>
    left.timestampSeq.localeCompare(right.timestampSeq),
  )) {
    const entry = terminalEntryText(item, startsAtLineBoundary);
    text += entry;
    startsAtLineBoundary = entry.length === 0 || /[\r\n]$/.test(entry);
  }
  return text;
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
