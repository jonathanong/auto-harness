import { describe, expect, it, vi } from "vitest";

import { readJson, send } from "./local-http.ts";

describe("local HTTP limits", () => {
  it("rejects oversized JSON bodies", async () => {
    let resumed = false;
    const req = {
      on(event: string, callback: (chunk?: Buffer) => void) {
        if (event === "data") callback(Buffer.alloc(1024 * 1024 + 1));
        if (event === "end") callback();
        return req;
      },
      resume() {
        resumed = true;
      },
    };
    await expect(readJson(req as never)).rejects.toThrow("exceeds 1 MiB");
    expect(resumed).toBe(true);
  });

  it("times out an oversized body without a destroy hook and treats a later error as oversized", async () => {
    vi.useFakeTimers();
    try {
      const handlers: Record<string, (chunk?: Buffer | Error) => void> = {};
      const req = {
        on(event: string, callback: (chunk?: Buffer | Error) => void) {
          handlers[event] = callback;
          return req;
        },
        resume() {},
      };
      const first = readJson(req as never);
      handlers.data?.(Buffer.alloc(1024 * 1024 + 1));
      const rejected = expect(first).rejects.toThrow("exceeds 1 MiB");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;

      const secondHandlers: Record<string, (chunk?: Buffer | Error) => void> = {};
      const secondReq = {
        on(event: string, callback: (chunk?: Buffer | Error) => void) {
          secondHandlers[event] = callback;
          return secondReq;
        },
        resume() {},
      };
      const second = readJson(secondReq as never);
      secondHandlers.data?.(Buffer.alloc(1024 * 1024 + 1));
      secondHandlers.error?.(new Error("socket reset"));
      await expect(second).rejects.toThrow("exceeds 1 MiB");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an empty body as an empty object", async () => {
    const req = {
      on(event: string, callback: () => void) {
        if (event === "end") callback();
        return req;
      },
    };
    await expect(readJson(req as never)).resolves.toEqual({});
  });

  it("supports minimal response fakes and no-content responses", () => {
    let written = "";
    const heads: number[] = [];
    const res = {
      writeHead(status: number) {
        heads.push(status);
      },
      end(payload?: string) {
        written = payload ?? "";
      },
    };
    send(res as never, 200, { ok: true });
    expect(written).toBe(JSON.stringify({ ok: true }));
    send(res as never, 204, null);
    expect(heads).toEqual([200, 204]);
  });
});
