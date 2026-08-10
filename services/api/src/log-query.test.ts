import { describe, expect, it } from "vitest";

import type { LogRecord } from "./control-plane-types.ts";
import { parseLogQuery, selectLogs } from "./log-query.ts";

const records: LogRecord[] = [
  {
    sessionId: "session",
    timestampSeq: "2026-01-01T00:00:00.000Z#0000000002",
    stream: "stderr",
    content: "second",
    timestamp: "2026-01-01T00:00:00.000Z",
    seq: 2,
  },
  {
    sessionId: "session",
    timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
    stream: "stdout",
    content: "first",
    timestamp: "2026-01-01T00:00:00.000Z",
    seq: 1,
  },
  {
    sessionId: "session",
    timestampSeq: "2026-01-01T00:00:01.000Z#0000000001",
    stream: "stdout",
    content: "third",
    timestamp: "2026-01-01T00:00:01.000Z",
    seq: 1,
  },
];

describe("historical log query contract", () => {
  it("validates and normalizes public query parameters", () => {
    expect(parseLogQuery(new URLSearchParams())).toEqual({ ok: true, query: { limit: 1000 } });
    expect(
      parseLogQuery(new URLSearchParams("stream=stdout&since=2026-01-01T01:00:00%2B01:00&limit=2")),
    ).toEqual({
      ok: true,
      query: { stream: "stdout", since: "2026-01-01T00:00:00.000Z", limit: 2 },
    });
  });

  it.each([
    "stream=other",
    "since=not-a-timestamp",
    "since=2026-02-30T00%3A00%3A00Z",
    "limit=0",
    "limit=1.5",
    "limit=1e3",
    "limit=10001",
  ])("rejects invalid query %s", (query) => {
    expect(parseLogQuery(new URLSearchParams(query))).toMatchObject({ ok: false });
  });

  it("filters before limiting and keeps total timestampSeq order", () => {
    expect(
      selectLogs(records, { stream: "stdout", limit: 1 }).map((record) => record.content),
    ).toEqual(["first"]);
    expect(
      selectLogs(records, { since: "2026-01-01T00:00:00.000Z", limit: 10 }).map(
        (record) => record.content,
      ),
    ).toEqual(["third"]);
  });
});
