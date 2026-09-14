import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { liveLogPortFromEnv, startLiveLogHttp } from "./live-log-http.ts";

describe("live log HTTP", () => {
  it("parses the loopback port from env", () => {
    expect(liveLogPortFromEnv({})).toBe(7424);
    expect(liveLogPortFromEnv({ HARNESS_DAEMON_LIVE_LOG_PORT: "off" })).toBeUndefined();
    expect(liveLogPortFromEnv({ HARNESS_DAEMON_LIVE_LOG_PORT: "0" })).toBeUndefined();
    expect(liveLogPortFromEnv({ HARNESS_DAEMON_LIVE_LOG_PORT: "7501" })).toBe(7501);
    expect(liveLogPortFromEnv({ HARNESS_DAEMON_LIVE_LOG_PORT: "nope" })).toBeUndefined();
    expect(liveLogPortFromEnv({ HARNESS_DAEMON_LIVE_LOG_PORT: "70000" })).toBeUndefined();
  });

  it("streams JSON chunks over SSE", async () => {
    const started = startLiveLogHttp({
      port: 0,
      subscribe: (_sessionId, emit) => {
        emit({
          sessionId: "s",
          attemptId: "a",
          stream: "stdout",
          content: "hello",
          timestamp: "2026-01-01T00:00:00.000Z",
          seq: 1,
        });
        return () => undefined;
      },
    });
    if (!started.server.listening) await once(started.server, "listening");
    const port = (started.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${String(port)}/sessions/s/logs/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("hello");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    await reader.cancel();
    await started.close();
  });

  it("rejects malformed percent encoding before subscribing", async () => {
    let subscribed = 0;
    const started = startLiveLogHttp({
      port: 0,
      subscribe: () => {
        subscribed += 1;
        return () => undefined;
      },
    });
    if (!started.server.listening) await once(started.server, "listening");
    const port = (started.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${String(port)}/sessions/%/logs/stream`);
    expect(response.status).toBe(400);
    expect(subscribed).toBe(0);
    await started.close();
  });

  it("rejects non-GET methods and unknown paths", async () => {
    const started = startLiveLogHttp({
      port: 0,
      subscribe: () => () => undefined,
    });
    if (!started.server.listening) await once(started.server, "listening");
    const port = (started.server.address() as AddressInfo).port;
    const post = await fetch(`http://127.0.0.1:${String(port)}/sessions/s/logs/stream`, {
      method: "POST",
    });
    expect(post.status).toBe(405);
    const missing = await fetch(`http://127.0.0.1:${String(port)}/health`);
    expect(missing.status).toBe(404);
    await started.close();
  });
});
