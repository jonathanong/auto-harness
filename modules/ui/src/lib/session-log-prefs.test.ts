import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readSessionLogPretty,
  readSessionLogView,
  SESSION_LOG_PRETTY_KEY,
  SESSION_LOG_VIEW_KEY,
  storeSessionLogPretty,
  storeSessionLogView,
} from "./session-log-prefs.ts";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    clear: () => store.clear(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session log prefs", () => {
  it("defaults to readable pretty-on and round-trips storage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(readSessionLogView()).toBe("readable");
    expect(readSessionLogPretty()).toBe(true);
    storeSessionLogView("raw");
    storeSessionLogPretty(false);
    expect(storage.getItem(SESSION_LOG_VIEW_KEY)).toBe("raw");
    expect(storage.getItem(SESSION_LOG_PRETTY_KEY)).toBe("off");
    expect(readSessionLogView()).toBe("raw");
    expect(readSessionLogPretty()).toBe(false);
    storeSessionLogPretty(true);
    expect(readSessionLogPretty()).toBe(true);
    storeSessionLogView("readable");
    expect(readSessionLogView()).toBe("readable");
  });

  it("tolerates missing and throwing storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readSessionLogView()).toBe("readable");
    expect(readSessionLogPretty()).toBe(true);
    storeSessionLogView("raw");
    storeSessionLogPretty(false);
    vi.stubGlobal("localStorage", undefined);
    expect(readSessionLogView()).toBe("readable");
    storeSessionLogView("raw");
  });
});
