import { describe, expect, it } from "vitest";

import { gunzipToUtf8 } from "@auto-harness/shared";

import { LogPartBuffer } from "./log-part-buffer.ts";

describe("LogPartBuffer", () => {
  it("does not upload when mode is off", async () => {
    const calls: string[] = [];
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "off",
        batchMaxKb: 1,
        batchMaxLines: 10,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
      },
      {
        apiUrl: "http://127.0.0.1:7420",
        fetchFn: (async (url) => {
          calls.push(String(url));
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "x",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    await buffer.flush();
    expect(calls).toEqual([]);
  });

  it("uploads a gzip part when mode is always", async () => {
    const bodies: Buffer[] = [];
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "always",
        batchMaxKb: 1,
        batchMaxLines: 10,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
      },
      {
        apiUrl: "http://127.0.0.1:7420/ws",
        apiKey: "hns_x",
        fetchFn: (async (_url, init) => {
          bodies.push(Buffer.from(init?.body as Uint8Array));
          return new Response(JSON.stringify({ key: "ok" }), { status: 200 });
        }) as typeof fetch,
      },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 3,
    });
    await buffer.flush();
    expect(gunzipToUtf8(bodies[0]!)).toContain("hello");
  });
});
