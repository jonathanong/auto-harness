import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-app.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { MemorySessionStore } from "./memory-store.ts";

describe("local API rate limits", () => {
  it("exempts health, emits standard headers, and resets deterministically", async () => {
    let now = 10_000;
    const store = new MemorySessionStore({ now: () => new Date(now).toISOString() });
    const events: string[] = [];
    const { handler } = createLocalApp({
      store,
      rateLimitNow: () => now,
      rateLimitConfig: { windowSeconds: 10, limits: { read: 1 } },
      onRateLimitEvent: (event) => events.push(`${event.bucket}:${event.outcome}`),
    });
    const health = await invokeHandler(handler, "GET", "/health");
    expect(health.status).toBe(200);
    const first = await invokeHandler(handler, "GET", "/api/v1/missing");
    expect(first.status).toBe(404);
    expect(first.raw).toContain("NOT_FOUND");
    const denied = await invokeHandler(handler, "GET", "/api/v1/missing");
    expect(denied.status).toBe(429);
    expect(denied.json).toEqual({ error: { code: "RATE_LIMITED", message: "too many requests" } });
    now = 20_000;
    expect((await invokeHandler(handler, "GET", "/api/v1/missing")).status).toBe(404);
    expect(events).toContain("read:denied");
  });

  it("audits denied mutations without request secrets", async () => {
    const store = new MemorySessionStore();
    const { handler, plane } = createLocalApp({
      store,
      rateLimitConfig: { limits: { mutation: 1 } },
      rateLimitNow: () => 50_000,
    });
    await invokeHandler(handler, "POST", "/api/v1/repositories", {
      name: "first",
      url: "https://example.test/repo.git",
    });
    const response = await invokeHandler(handler, "POST", "/api/v1/repositories", {
      name: "second",
      password: "must-not-be-audit-value",
    });
    expect(response.status).toBe(429);
    const audits = await plane.listAuditLogs();
    expect(audits.items.some((audit) => audit.action === "rate-limit:deny")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("must-not-be-audit-value");
  });
});
