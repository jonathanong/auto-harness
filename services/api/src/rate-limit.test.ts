import { describe, expect, it } from "vitest";

import {
  classifyRateLimitBucket,
  clientSourceKey,
  DEFAULT_RATE_LIMIT_CONFIG,
  MemoryRateLimiter,
  rateLimitConfigFromEnv,
  retryAfterSeconds,
  windowStartMs,
} from "./rate-limit.ts";

describe("rate limit policy", () => {
  it("allows the boundary token and denies the next request", () => {
    const limiter = new MemoryRateLimiter(10);
    expect(limiter.consume("actor", 2, 60, 59_999)).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAtMs: 60_000,
    });
    expect(limiter.consume("actor", 2, 60, 60_000)).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAtMs: 120_000,
    });
    expect(limiter.consume("actor", 2, 60, 60_001)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume("actor", 2, 60, 60_002)).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("bounds memory by evicting the oldest key", () => {
    const limiter = new MemoryRateLimiter(2);
    limiter.consume("a", 1, 60, 0);
    limiter.consume("b", 1, 60, 1);
    limiter.consume("c", 1, 60, 2);
    expect(limiter.size()).toBe(2);
    expect(limiter.consume("a", 1, 60, 3).allowed).toBe(true);
  });

  it("classifies login, scheduler, host, reads, mutations, and non-api paths", () => {
    expect(classifyRateLimitBucket("POST", "/api/v1/auth/login", true)).toBe("login");
    expect(classifyRateLimitBucket("GET", "/api/v1/sessions")).toBe("read");
    expect(classifyRateLimitBucket("POST", "/api/v1/scheduler/assign")).toBe("scheduler");
    expect(classifyRateLimitBucket("GET", "/api/v1/hosts")).toBe("host");
    expect(classifyRateLimitBucket("POST", "/api/v1/hosts/drain")).toBe("host");
    expect(classifyRateLimitBucket("POST", "/api/v1/sessions")).toBe("mutation");
    expect(classifyRateLimitBucket("GET", "/health")).toBeNull();
  });

  it("does not trust forwarded addresses unless explicitly configured", () => {
    const req = {
      headers: { "x-forwarded-for": "spoofed, proxy" },
      socket: { remoteAddress: "10.0.0.2" },
    };
    expect(clientSourceKey(req, false)).toBe("ip:10.0.0.2");
    expect(clientSourceKey(req, true)).toBe("ip:spoofed");
    expect(clientSourceKey({ headers: {}, socket: {} }, false)).toBe("ip:unknown");
    expect(
      clientSourceKey(
        { headers: { "x-forwarded-for": ["198.51.100.3", "proxy"] }, socket: {} },
        true,
      ),
    ).toBe("ip:198.51.100.3");
  });

  it("parses safe environment overrides and retry boundaries", () => {
    const config = rateLimitConfigFromEnv({
      HARNESS_RATE_LIMIT_WINDOW_SECONDS: "5",
      HARNESS_RATE_LIMIT_READ: "7",
      HARNESS_RATE_LIMIT_FAIL_MODE: "open",
      HARNESS_RATE_LIMIT_MODE: "disabled",
    });
    expect(config.windowSeconds).toBe(5);
    expect(config.limits.read).toBe(7);
    expect(config.failMode).toBe("open");
    expect(config.enabled).toBe(false);
    expect(windowStartMs(5_999, 5)).toBe(5_000);
    expect(retryAfterSeconds(6_000, 5_001)).toBe(1);
    expect(DEFAULT_RATE_LIMIT_CONFIG.maxEntries).toBeGreaterThan(0);
    expect(rateLimitConfigFromEnv({ HARNESS_RATE_LIMIT_READ: "0" }).limits.read).toBe(
      DEFAULT_RATE_LIMIT_CONFIG.limits.read,
    );
  });
});
