import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { ArchiveWriteResult } from "./archive-writer.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

/**
 * Regression coverage for the production bug where `GET /sessions/:id/logs` returned
 * `{"items": []}` for every archived (terminal) session: the writer (`archiveBody`) dropped
 * `seq` from the archive JSONL, and the reader (`parseGzipJsonlLogs`) silently rejected any
 * line without a numeric `seq`, so the archive always parsed to zero records.
 */
describe("GET /sessions/:id/logs after real terminal archival", () => {
  it("serves archived logs with seq once the session's transcript has been archived", async () => {
    const stored = new Map<string, Buffer>();
    const archiveWriter = {
      putArchive: async ({
        key,
        body,
      }: {
        key: string;
        body: string;
        contentType: string;
      }): Promise<ArchiveWriteResult> => {
        stored.set(key, gzipSync(Buffer.from(body)));
        return { versionId: "archived-v1" };
      },
      listKeys: async (prefix: string) => [...stored.keys()].filter((k) => k.startsWith(prefix)),
      getGzipObject: async (key: string) => stored.get(key),
    };
    const plane = new ControlPlane({ archiveWriter });
    plane.state.sessions.set("session", {
      id: "session",
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt",
      source: "api",
    });
    plane.state.logs.set("session", [
      {
        sessionId: "session",
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
        stream: "stdout",
        content: "done",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      },
    ]);

    await plane.archiveSessionLogs("session");
    // Archival prunes the recent-log rows in production; only the S3 object remains.
    plane.state.logs.delete("session");

    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/session/logs");
    expect(response.status).toBe(200);
    expect((response.json as { items: Array<{ content: string; seq: number }> }).items).toEqual([
      expect.objectContaining({ content: "done", seq: 1 }),
    ]);
  });

  it("serves a pre-existing legacy archive (no seq) instead of the reported empty items", async () => {
    // Reproduces the exact verified production shape: a stored logs.jsonl.gz whose lines are
    // {timestamp, stream, content} with no seq at all -- what GET /logs used to turn into
    // {"items": []}.
    const plane = new ControlPlane();
    plane.state.sessions.set("session", {
      id: "session",
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt",
      source: "api",
    });
    plane.state.logObjects.set(
      "sessions/session/logs.jsonl.gz",
      gzipSync(
        Buffer.from(
          `${JSON.stringify({
            timestamp: "2026-01-01T00:00:00.000Z",
            stream: "stdout",
            content: "legacy line",
          })}\n`,
        ),
      ),
    );

    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/session/logs");
    expect(response.status).toBe(200);
    expect((response.json as { items: Array<{ content: string; seq: number }> }).items).toEqual([
      expect.objectContaining({ content: "legacy line", seq: 0 }),
    ]);
  });
});
