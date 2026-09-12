import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { readRawBody } from "./local-http.ts";
import { createLocalApp } from "./local-server.ts";

type Listener = (...args: never[]) => void;

function request() {
  const listeners = new Map<string, Listener>();
  const destroy = vi.fn();
  const resume = vi.fn();
  return {
    req: {
      on(event: string, listener: Listener) {
        listeners.set(event, listener);
        return this;
      },
      destroy,
      resume,
    },
    emit(event: string, ...args: never[]) {
      listeners.get(event)?.(...args);
    },
    destroy,
    resume,
  };
}

describe("raw request bodies", () => {
  it("preserves exact chunks without JSON parsing", async () => {
    const stream = request();
    const body = readRawBody(stream.req as never, 8);
    stream.emit("data", Buffer.from('{"a"'));
    stream.emit("data", Buffer.from(":1}"));
    stream.emit("end");
    await expect(body).resolves.toEqual(Buffer.from('{"a":1}'));
    expect(stream.destroy).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies once and ignores a later end event", async () => {
    const stream = request();
    const body = readRawBody(stream.req as never, 3);
    stream.emit("data", Buffer.from("four"));
    stream.emit("data", Buffer.alloc(1024 * 1024));
    stream.emit("end");
    await expect(body).rejects.toThrow("request body exceeds route limit");
    expect(stream.resume).toHaveBeenCalledOnce();
    expect(stream.destroy).not.toHaveBeenCalled();
  });

  it("propagates stream failures", async () => {
    const stream = request();
    const body = readRawBody(stream.req as never, 8);
    stream.emit("error", new Error("connection reset") as never);
    await expect(body).rejects.toThrow("connection reset");
  });

  it("delivers 413 to a real HTTP client for an oversized Slack event", async () => {
    const handler = createLocalApp({
      plane: new ControlPlane(),
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    }).handler;
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.on("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/integrations/slack/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.alloc(256 * 1024 + 1, 0x78),
        },
      );
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: { code: "PAYLOAD_TOO_LARGE", message: "Slack event exceeds route limit" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
