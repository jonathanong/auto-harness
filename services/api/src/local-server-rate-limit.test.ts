import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
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
    expect(denied.headers.get("x-ratelimit-limit")).toBe(1);
    expect(denied.headers.get("x-ratelimit-remaining")).toBe(0);
    expect(denied.headers.get("x-ratelimit-reset")).toBe(20);
    expect(denied.headers.get("retry-after")).toBe(10);
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

  it("uses independent authenticated actor budgets", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "admin", password: "password" }])).toString(
        "base64",
      ),
    });
    const first = await auth.createServiceAccount({ name: "first", role: "admin" });
    await auth.createUser({ username: "second", password: "password", role: "admin" });
    const { handler } = createLocalApp({
      authService: auth,
      rateLimitConfig: { limits: { mutation: 1 } },
      rateLimitNow: () => 50_000,
    });
    const create = (authorization: string, name: string) =>
      invokeHandler(
        handler,
        "POST",
        "/api/v1/repositories",
        { name, url: `https://example.test/${name}.git` },
        { authorization },
      );

    expect((await create(`Bearer ${first.apiKey}`, "first")).status).toBe(201);
    expect(
      (await create(`Basic ${Buffer.from("second:password").toString("base64")}`, "second")).status,
    ).toBe(201);
    expect((await create(`Bearer ${first.apiKey}`, "third")).status).toBe(429);
  });

  it("does not bill authenticated traffic to the IP login bucket", async () => {
    const events: string[] = [];
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "admin", password: "password" }])).toString(
        "base64",
      ),
    });
    const { apiKey } = await auth.createServiceAccount({ name: "reader", role: "read-only" });
    const { handler } = createLocalApp({
      authService: auth,
      rateLimitNow: () => 50_000,
      rateLimitConfig: { limits: { login: 1, read: 10 } },
      onRateLimitEvent: (event) => events.push(`${event.bucket}:${event.outcome}`),
    });
    const headers = { authorization: `Bearer ${apiKey}` };

    expect(
      (await invokeHandler(handler, "GET", "/api/v1/repositories", undefined, headers)).status,
    ).toBe(200);
    expect(
      (await invokeHandler(handler, "GET", "/api/v1/repositories", undefined, headers)).status,
    ).toBe(200);
    expect(events.filter((event) => event.startsWith("login:"))).toEqual([]);
    expect(events.filter((event) => event === "read:allowed")).toHaveLength(2);

    expect((await invokeHandler(handler, "GET", "/api/v1/repositories")).status).toBe(401);
    expect((await invokeHandler(handler, "GET", "/api/v1/repositories")).status).toBe(429);
    expect(events).toContain("login:denied");
  });

  it("fails closed when a denied mutation cannot be appended to the audit trail", async () => {
    const store = new MemorySessionStore();
    const events: string[] = [];
    const { handler, plane } = createLocalApp({
      store,
      rateLimitConfig: { limits: { mutation: 1 } },
      rateLimitNow: () => 50_000,
      onRateLimitEvent: (event) => events.push(event.outcome),
    });
    await invokeHandler(handler, "POST", "/api/v1/repositories", {
      name: "first",
      url: "https://example.test/first.git",
    });
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };

    const response = await invokeHandler(handler, "POST", "/api/v1/repositories", {
      name: "second",
    });
    expect(response.status).toBe(500);
    expect(events).toContain("error");
  });
});
