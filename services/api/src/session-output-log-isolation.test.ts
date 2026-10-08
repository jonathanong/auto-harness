import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { gzipLogRecords, readSessionLogObjects } from "./session-log-objects.ts";

describe("session output archives and transcript isolation", () => {
  it("reads transcript parts without fetching artifact objects under the same session prefix", async () => {
    const partKey = "sessions/sess/parts/1-1.jsonl.gz";
    const artifactKey = "sessions/sess/artifacts/attempt.tar.gz";
    const otherSessionPart = "sessions/other/parts/1-1.jsonl.gz";
    const part = gzipLogRecords([
      {
        sessionId: "sess",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "transcript survives artifacts",
        seq: 1,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      },
    ]);
    const reads: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => undefined,
        listKeys: async () => [artifactKey, partKey],
        getGzipObject: async (key) => {
          reads.push(key);
          if (key !== partKey) throw new Error("artifact parsed as transcript");
          return part;
        },
      },
    });
    state.logObjects.set(artifactKey, Buffer.from("not gzip JSONL"));
    state.logObjects.set(otherSessionPart, part);
    expect((await readSessionLogObjects(state, "sess"))?.map((line) => line.content)).toEqual([
      "transcript survives artifacts",
    ]);
    expect(reads).toEqual([partKey]);
  });

  it("returns no transcript when the session owns only artifact objects", async () => {
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => undefined,
        listKeys: async () => ["sessions/sess/artifacts/attempt.tar.gz"],
        getGzipObject: async () => {
          throw new Error("artifact parsed as transcript");
        },
      },
    });
    state.logObjects.set("sessions/sess/artifacts/attempt.tar.gz", Buffer.from("artifact"));
    expect(await readSessionLogObjects(state, "sess")).toBeUndefined();
  });
});
