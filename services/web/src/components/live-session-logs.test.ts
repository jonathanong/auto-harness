import { describe, expect, it } from "vitest";

import { lastLiveCursor, mergeLiveLogs, validLiveLog } from "./live-session-logs.ts";

const first = {
  timestampSeq: "2026-08-10T12:00:00.000Z#0000000001",
  timestamp: "2026-08-10T12:00:00.000Z",
  seq: 1,
  stream: "stdout",
  content: "first",
};

describe("live session log client state", () => {
  it("orders cursor records, deduplicates reconnect replay, and bounds the tail", () => {
    const second = { ...first, timestampSeq: "2026-08-10T12:00:01.000Z#0000000002", seq: 2 };
    const third = { ...first, timestampSeq: "2026-08-10T12:00:02.000Z#0000000003", seq: 3 };
    let entries = mergeLiveLogs([], second, 2);
    entries = mergeLiveLogs(entries, first, 2);
    entries = mergeLiveLogs(entries, second, 2);
    entries = mergeLiveLogs(entries, third, 2);

    expect(entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(lastLiveCursor(entries)).toBe(third.timestampSeq);
  });

  it("rejects malformed websocket records before they reach React state", () => {
    expect(validLiveLog({ ...first, timestampSeq: "" })).toBe(false);
    expect(validLiveLog({ ...first, seq: -1 })).toBe(false);
    expect(validLiveLog({ ...first, content: 1 })).toBe(false);
  });
});
