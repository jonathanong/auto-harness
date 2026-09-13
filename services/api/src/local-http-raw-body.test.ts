import { Agent, createServer, request as httpRequest } from "node:http";

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

  it("drains remaining bytes before rejecting an oversized body", async () => {
    const stream = request();
    const body = readRawBody(stream.req as never, 3);
    stream.emit("data", Buffer.from("four"));
    stream.emit("data", Buffer.alloc(1024 * 1024));
    let settled = false;
    void body.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(stream.resume).toHaveBeenCalledOnce();
    expect(stream.destroy).not.toHaveBeenCalled();
    stream.emit("end");
    await expect(body).rejects.toThrow("request body exceeds route limit");
    expect(settled).toBe(true);
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

  it("keeps a keep-alive connection usable after draining an oversized body", async () => {
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
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    const exchange = (
      method: string,
      path: string,
      body?: Buffer,
    ): Promise<{ status: number; json: unknown; reusedSocket: boolean }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            method,
            path,
            agent,
            headers: body
              ? { "content-type": "application/json", "content-length": body.length }
              : {},
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: res.statusCode ?? 0,
                json: raw ? (JSON.parse(raw) as unknown) : null,
                reusedSocket: req.reusedSocket === true,
              });
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });

    try {
      const oversized = await exchange(
        "POST",
        "/api/v1/webhooks/custom/deploy",
        Buffer.alloc(1024 * 1024 + 1, 0x78),
      );
      expect(oversized).toMatchObject({
        status: 400,
        json: { error: { code: "VALIDATION_ERROR" } },
      });
      const health = await exchange("GET", "/health");
      expect(health).toMatchObject({ status: 200, json: { ok: true }, reusedSocket: true });
    } finally {
      agent.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
