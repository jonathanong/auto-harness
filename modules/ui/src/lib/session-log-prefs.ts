export const SESSION_LOG_VIEW_KEY = "auto-harness.session-log-view";
export const SESSION_LOG_PRETTY_KEY = "auto-harness.session-log-pretty";

export type SessionLogViewMode = "readable" | "raw";

function read(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // private mode / disabled storage
  }
}

export function readSessionLogView(): SessionLogViewMode {
  return read(SESSION_LOG_VIEW_KEY) === "raw" ? "raw" : "readable";
}

export function readSessionLogPretty(): boolean {
  return read(SESSION_LOG_PRETTY_KEY) !== "off";
}

export function storeSessionLogView(mode: SessionLogViewMode): void {
  write(SESSION_LOG_VIEW_KEY, mode);
}

export function storeSessionLogPretty(pretty: boolean): void {
  write(SESSION_LOG_PRETTY_KEY, pretty ? "on" : "off");
}
