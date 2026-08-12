import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-app.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("durable local rate-limit enforcement", () => {
  it("uses the durable decision and returns its headers", async () => {
    const plane = new ControlPlane();
    const calls: unknown[] = [];
    plane.state.storage = {
      rateLimitStore: true,
      consumeRateLimit: async (input: unknown) => {
        calls.push(input);
        return { allowed: false, limit: 4, remaining: 0, resetAtMs: 60_000 };
      },
    } as never;
    const { handler } = createLocalApp({ plane, rateLimitNow: () => 55_100 });

    const response = await invokeHandler(handler, "GET", "/api/v1/missing");
    expect(response.status).toBe(429);
    expect(response.headers.get("x-ratelimit-limit")).toBe(4);
    expect(response.headers.get("retry-after")).toBe(5);
    expect(calls).toHaveLength(1);
  });

  it("returns 503 by default when durable counters fail, or continues in explicit open mode", async () => {
    const unavailable = new ControlPlane();
    unavailable.state.storage = {
      rateLimitStore: true,
      consumeRateLimit: async () => {
        throw new Error("unavailable");
      },
    } as never;
    const errors: string[] = [];
    const closed = createLocalApp({
      plane: unavailable,
      rateLimitNow: () => 55_100,
      onRateLimitEvent: (event) => errors.push(event.outcome),
    });
    const rejected = await invokeHandler(closed.handler, "GET", "/api/v1/missing");
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("x-ratelimit-remaining")).toBe(0);
    expect(errors).toEqual(["error"]);

    const open = createLocalApp({
      plane: unavailable,
      rateLimitConfig: { failMode: "open" },
      rateLimitNow: () => 55_100,
    });
    expect((await invokeHandler(open.handler, "GET", "/api/v1/missing")).status).toBe(404);
  });

  it("can be disabled for an isolated loopback test", async () => {
    const { handler } = createLocalApp({ rateLimitConfig: { enabled: false } });
    const response = await invokeHandler(handler, "GET", "/api/v1/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("x-ratelimit-limit")).toBeUndefined();
  });
});
