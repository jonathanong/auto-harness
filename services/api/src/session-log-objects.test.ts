import { describe, expect, it } from "vitest";

import { gzipJsonlLines } from "@auto-harness/shared";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  gzipLogRecords,
  parseGzipJsonlLogs,
  putSessionLogPart,
  readSessionLogObjects,
} from "./session-log-objects.ts";

describe("session log objects", () => {
  it("round-trips gzip JSONL records", () => {
    const gzipped = gzipJsonlLines([
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "hello",
        seq: 1,
      }),
    ]);
    expect(parseGzipJsonlLogs("sess", gzipped)).toEqual([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "hello",
        seq: 1,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      },
    ]);
  });

  it("stores and reads parts from memory", async () => {
    const state = createControlPlaneState();
    const gzipped = gzipLogRecords([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "a",
        seq: 1,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      },
    ]);
    await putSessionLogPart(state, "sess", 1, 1, gzipped);
    const records = await readSessionLogObjects(state, "sess");
    expect(records?.map((record) => record.content)).toEqual(["a"]);
  });
});
