import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_LOG_SETTINGS,
  isSessionLogObjectKey,
  normalizeSessionLogSettings,
  publicSessionLogSettings,
  sessionLogArchiveKey,
  sessionLogPartKey,
} from "./session-log-settings.ts";

describe("session log settings", () => {
  it("defaults to upload off and a one-minute flush and poll", () => {
    expect(normalizeSessionLogSettings(undefined)).toEqual(DEFAULT_SESSION_LOG_SETTINGS);
    expect(DEFAULT_SESSION_LOG_SETTINGS.uploadMode).toBe("off");
    expect(DEFAULT_SESSION_LOG_SETTINGS.batchMaxWaitMs).toBe(60_000);
    expect(DEFAULT_SESSION_LOG_SETTINGS.controlPlanePollMs).toBe(60_000);
  });

  it("clamps batch and poll bounds", () => {
    const next = normalizeSessionLogSettings({
      uploadMode: "always",
      batchMaxKb: 0,
      batchMaxLines: 99_999,
      batchMaxWaitMs: 100,
      controlPlanePollMs: 10,
    });
    expect(next.uploadMode).toBe("always");
    expect(next.batchMaxKb).toBe(1);
    expect(next.batchMaxLines).toBe(50_000);
    expect(next.batchMaxWaitMs).toBe(1_000);
    expect(next.controlPlanePollMs).toBe(5_000);
  });

  it("rejects unknown upload modes", () => {
    expect(normalizeSessionLogSettings({ uploadMode: "sometimes" as never }).uploadMode).toBe(
      "off",
    );
  });

  it("exposes a versioned public snapshot and defaults version to zero", () => {
    expect(publicSessionLogSettings(undefined)).toEqual({
      ...DEFAULT_SESSION_LOG_SETTINGS,
      version: 0,
    });
    expect(publicSessionLogSettings({ uploadMode: "always", version: 3 })).toMatchObject({
      uploadMode: "always",
      version: 3,
    });
    expect(publicSessionLogSettings({ version: -1 }).version).toBe(0);
  });

  it("builds gzip part and archive keys", () => {
    expect(sessionLogPartKey("sess", 1, 40)).toBe("sessions/sess/parts/1-40.jsonl.gz");
    expect(sessionLogArchiveKey("sess")).toBe("sessions/sess/logs.jsonl.gz");
    expect(isSessionLogObjectKey("sessions/sess/parts/1-40.jsonl.gz")).toBe(true);
    expect(isSessionLogObjectKey("sessions/sess/logs.jsonl.gz")).toBe(true);
    expect(isSessionLogObjectKey("sessions/sess/logs.jsonl")).toBe(false);
    expect(isSessionLogObjectKey("other/sess/logs.jsonl.gz")).toBe(false);
  });
});
