import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writePriorContextFile } from "./prior-context-file.ts";

const identity = { apiUrl: "http://127.0.0.1:7420", apiKey: "secret-token" };

/** A fetch stub that rejects like a real aborted fetch once its signal fires. */
function abortableFetchFn(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "prior-context-cancel-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("writePriorContextFile signal/timeoutMs propagation", () => {
  it("never starts the fetch when the given signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const path = await writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      signal: controller.signal,
      fetchFn: async (_url, init) => {
        if ((init as RequestInit).signal?.aborted) throw new DOMException("aborted", "AbortError");
        return new Response(JSON.stringify({ content: "x" }), { status: 200 });
      },
    });
    expect(path).toBeNull();
  });

  it("aborts an in-flight fetch when the given signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = writePriorContextFile({
      cwd,
      sessionId: "sess-2",
      identity,
      signal: controller.signal,
      fetchFn: abortableFetchFn,
    });
    controller.abort();
    expect(await promise).toBeNull();
  });

  it("honors a timeoutMs shorter than the fixed fetch cap", async () => {
    vi.useFakeTimers();
    try {
      const promise = writePriorContextFile({
        cwd,
        sessionId: "sess-2",
        identity,
        timeoutMs: 5_000,
        fetchFn: abortableFetchFn,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await promise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
