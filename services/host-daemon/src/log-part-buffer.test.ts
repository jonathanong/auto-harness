/* eslint-disable max-lines -- flush serialization and upload-mode cases share one buffer fixture. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { gunzipToUtf8 } from "@auto-harness/shared";

import { LogPartBuffer } from "./log-part-buffer.ts";

describe("LogPartBuffer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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

  it("uploads concatenated gzip members as the terminal archive", async () => {
    const urls: string[] = [];
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
        apiUrl: "http://127.0.0.1:7420",
        fetchFn: (async (url) => {
          urls.push(String(url));
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
      seq: 1,
    });
    await buffer.flushFinal();
    expect(urls.some((url) => url.includes("/log-archive"))).toBe(true);
  });

  it("uploads while subscribed only after watching is set", async () => {
    const urls: string[] = [];
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "subscribed",
        batchMaxKb: 1,
        batchMaxLines: 10,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
      },
      {
        apiUrl: "http://127.0.0.1:7420",
        fetchFn: (async (url) => {
          urls.push(String(url));
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "hidden",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    await buffer.flush();
    expect(urls).toEqual([]);
    buffer.watching = true;
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "visible",
      timestamp: "2026-01-01T00:00:01.000Z",
      seq: 2,
    });
    await buffer.flush();
    expect(urls).toHaveLength(1);
  });

  it("restores the batch when the part upload fails", async () => {
    let attempts = 0;
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
        apiUrl: "http://127.0.0.1:7420",
        fetchFn: (async () => {
          attempts += 1;
          return new Response(null, { status: attempts === 1 ? 503 : 200 });
        }) as typeof fetch,
      },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "retry-me",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    await expect(buffer.flush()).rejects.toThrow("log part upload failed: 503");
    await buffer.flush();
    expect(attempts).toBe(2);
  });

  it("waits for an in-flight part upload before writing the archive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    const urls: string[] = [];
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "always",
        batchMaxKb: 1,
        batchMaxLines: 1,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
      },
      {
        apiUrl: "http://127.0.0.1:7420",
        fetchFn: (async (url) => {
          urls.push(String(url));
          if (String(url).includes("/log-parts")) {
            started();
            await gate;
          }
          return new Response(JSON.stringify({ key: "ok" }), { status: 200 });
        }) as typeof fetch,
      },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "hello world",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    await startedAt;
    const done = buffer.flushFinal();
    expect(urls.some((url) => url.includes("/log-archive"))).toBe(false);
    release();
    await done;
    expect(urls.some((url) => url.includes("/log-parts"))).toBe(true);
    expect(urls.some((url) => url.includes("/log-archive"))).toBe(true);
  });

  it("flushes on the batch timer when the part is still under size", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "always",
        batchMaxKb: 256,
        batchMaxLines: 500,
        batchMaxWaitMs: 25,
        controlPlanePollMs: 60_000,
      },
      {
        apiUrl: "http://127.0.0.1:7420",
        fetchFn: (async (url) => {
          urls.push(String(url));
          return new Response(JSON.stringify({ key: "ok" }), { status: 200 });
        }) as typeof fetch,
      },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "tick",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    expect(urls).toEqual([]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(urls).toHaveLength(1);
  });

  it("uses global fetch when the upload has no fetchFn", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "always",
        batchMaxKb: 1,
        batchMaxLines: 10,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
      },
      { apiUrl: "http://127.0.0.1:7420" },
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "global",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    await buffer.flush();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("includes dropped counts and no-ops a final flush with nothing uploaded", async () => {
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
        apiUrl: "http://127.0.0.1:7420",
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
      content: "gap",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 4,
      dropped: 3,
    });
    await buffer.flush();
    expect(gunzipToUtf8(bodies[0]!)).toContain('"dropped":3');
    const empty = new LogPartBuffer("sess", { uploadMode: "always" } as never, undefined);
    await empty.flushFinal();
  });

  it("emits local chunks even when upload is off", () => {
    const seen: string[] = [];
    const buffer = new LogPartBuffer(
      "sess",
      {
        uploadMode: "off",
        batchMaxKb: 1,
        batchMaxLines: 10,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
      },
      undefined,
      (chunk) => seen.push(chunk.content),
    );
    buffer.push({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "local",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    expect(seen).toEqual(["local"]);
  });
});
