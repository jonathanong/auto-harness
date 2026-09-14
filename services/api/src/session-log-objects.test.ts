import { describe, expect, it } from "vitest";

import { gzipJsonlLines } from "@auto-harness/shared";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  gzipLogRecords,
  parseGzipJsonlLogs,
  putSessionLogArchive,
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

  it("rejects empty parts and seqs outside the declared range", async () => {
    const state = createControlPlaneState();
    await expect(putSessionLogPart(state, "sess", 1, 1, gzipJsonlLines([]))).rejects.toThrow(
      "empty log part",
    );
    const gzipped = gzipLogRecords([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "a",
        seq: 9,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000009",
      },
    ]);
    await expect(putSessionLogPart(state, "sess", 1, 1, gzipped)).rejects.toThrow(
      "seq outside declared range",
    );
  });

  it("reads gzip objects from the archive writer and skips malformed lines", async () => {
    const gzipped = gzipJsonlLines([
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "ok",
        seq: 1,
        dropped: 2,
      }),
      JSON.stringify({ seq: "bad" }),
      "",
    ]);
    const objects = new Map<string, Buffer>([["sessions/sess/parts/1-1.jsonl.gz", gzipped]]);
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => undefined,
        listKeys: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
        getGzipObject: async (key) => objects.get(key),
      },
    });
    const records = await readSessionLogObjects(state, "sess", { stream: "stdout", limit: 10 });
    expect(records?.map((record) => record.content)).toEqual(["ok"]);
    expect(records?.[0]?.dropped).toBe(2);
  });

  it("stores a concat archive in memory and skips missing gzip objects", async () => {
    const state = createControlPlaneState();
    const gzipped = gzipLogRecords([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "archive",
        seq: 1,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      },
    ]);
    await putSessionLogArchive(state, "sess", gzipped);
    expect((await readSessionLogObjects(state, "sess"))?.map((record) => record.content)).toEqual([
      "archive",
    ]);
    const missing = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => undefined,
        listKeys: async () => ["sessions/sess/parts/1-1.jsonl.gz"],
        getGzipObject: async () => undefined,
      },
    });
    expect(await readSessionLogObjects(missing, "sess")).toEqual([]);
  });

  it("prefers the terminal archive over leftover part objects", async () => {
    const part = gzipLogRecords([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "part",
        seq: 1,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      },
    ]);
    const archive = gzipLogRecords([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "archive",
        seq: 1,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      },
    ]);
    const objects = new Map<string, Buffer>([
      ["sessions/sess/parts/1-1.jsonl.gz", part],
      ["sessions/sess/logs.jsonl.gz", archive],
    ]);
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => undefined,
        listKeys: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
        getGzipObject: async (key) => objects.get(key),
      },
    });
    expect((await readSessionLogObjects(state, "sess"))?.map((record) => record.content)).toEqual([
      "archive",
    ]);
  });
});
