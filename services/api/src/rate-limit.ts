import { createHash } from "node:crypto";

export type RateLimitBucket = "login" | "read" | "mutation" | "scheduler" | "host";

export type RateLimitLimits = Record<RateLimitBucket, number>;

export type RateLimitConfig = {
  enabled: boolean;
  windowSeconds: number;
  limits: RateLimitLimits;
  maxEntries: number;
  /** What to do when durable enforcement cannot be reached. */
  failMode: "closed" | "open";
};

export type RateLimitConfigOverrides = Partial<RateLimitConfig> & {
  limits?: Partial<RateLimitLimits>;
};

export function mergeRateLimitConfig(overrides: RateLimitConfigOverrides = {}): RateLimitConfig {
  return {
    ...DEFAULT_RATE_LIMIT_CONFIG,
    ...overrides,
    limits: { ...DEFAULT_RATE_LIMIT_CONFIG.limits, ...overrides.limits },
  };
}

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
};

export type RateLimitEvent = {
  outcome: "allowed" | "denied" | "error";
  bucket: RateLimitBucket;
  limit: number;
  remaining?: number;
  resetAtMs?: number;
  /** Deliberately a bucket key, never a credential, body, or IP address. */
  actorKey: string;
};

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  enabled: true,
  windowSeconds: 60,
  limits: {
    login: 10,
    read: 300,
    mutation: 60,
    scheduler: 60,
    // Host REST traffic is mostly inventory and control messages. WebSocket
    // frames have a separate per-connection limit in ws-hub.ts.
    host: 600,
  },
  maxEntries: 10_000,
  failMode: "closed",
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse process configuration once at listener creation. Invalid values use safe defaults. */
export function rateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const defaults = DEFAULT_RATE_LIMIT_CONFIG;
  return {
    enabled: !["0", "false", "off", "disabled"].includes(
      (env.HARNESS_RATE_LIMIT_MODE ?? "").toLowerCase(),
    ),
    windowSeconds: positiveInt(env.HARNESS_RATE_LIMIT_WINDOW_SECONDS, defaults.windowSeconds),
    limits: {
      login: positiveInt(env.HARNESS_RATE_LIMIT_LOGIN, defaults.limits.login),
      read: positiveInt(env.HARNESS_RATE_LIMIT_READ, defaults.limits.read),
      mutation: positiveInt(env.HARNESS_RATE_LIMIT_MUTATION, defaults.limits.mutation),
      scheduler: positiveInt(env.HARNESS_RATE_LIMIT_SCHEDULER, defaults.limits.scheduler),
      host: positiveInt(env.HARNESS_RATE_LIMIT_HOST, defaults.limits.host),
    },
    maxEntries: positiveInt(env.HARNESS_RATE_LIMIT_MAX_ENTRIES, defaults.maxEntries),
    failMode: env.HARNESS_RATE_LIMIT_FAIL_MODE === "open" ? "open" : "closed",
  };
}

export function limitFor(config: RateLimitConfig, bucket: RateLimitBucket): number {
  return config.limits[bucket];
}

export function windowStartMs(nowMs: number, windowSeconds: number): number {
  const size = windowSeconds * 1000;
  return Math.floor(nowMs / size) * size;
}

export function retryAfterSeconds(resetAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}

/** Stable, non-secret DynamoDB key. Raw credentials and addresses never become table keys. */
export function rateLimitStorageKey(actorKey: string, bucket: RateLimitBucket): string {
  return createHash("sha256").update(`${bucket}\0${actorKey}`).digest("hex");
}

type MemoryEntry = { windowStartMs: number; count: number; touchedAtMs: number };

/** Fixed-window limiter for local/in-process mode with an explicit memory bound. */
export class MemoryRateLimiter {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_RATE_LIMIT_CONFIG.maxEntries) {
    this.maxEntries = maxEntries;
  }

  consume(key: string, limit: number, windowSeconds: number, nowMs: number): RateLimitDecision {
    const start = windowStartMs(nowMs, windowSeconds);
    const resetAtMs = start + windowSeconds * 1000;
    const existing = this.entries.get(key);
    const entry =
      existing?.windowStartMs === start
        ? existing
        : { windowStartMs: start, count: 0, touchedAtMs: nowMs };
    if (!existing || existing.windowStartMs !== start) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      this.evictIfNeeded();
    }
    entry.touchedAtMs = nowMs;
    if (entry.count >= limit) {
      return { allowed: false, limit, remaining: 0, resetAtMs };
    }
    entry.count += 1;
    return { allowed: true, limit, remaining: Math.max(0, limit - entry.count), resetAtMs };
  }

  size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      // The map cannot be empty while its size exceeds maxEntries.
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

export function classifyRateLimitBucket(
  method: string,
  pathname: string,
  login = false,
): RateLimitBucket | null {
  if (login) return "login";
  if (!pathname.startsWith("/api/v1/")) return null;
  if (pathname.startsWith("/api/v1/scheduler/")) return "scheduler";
  if (
    pathname.startsWith("/api/v1/hosts") ||
    pathname.startsWith("/api/v1/host-inventories") ||
    pathname.startsWith("/api/v1/host/")
  )
    return "host";
  if (method === "GET" || method === "HEAD") return "read";
  return "mutation";
}

export function clientSourceKey(
  // Structurally compatible with node:http's IncomingMessage, whose own
  // socket.remoteAddress is `string | undefined`, not just optional.
  req: {
    headers?: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string | undefined };
  },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers?.["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return `ip:${first.trim()}`;
  }
  return `ip:${req.socket?.remoteAddress ?? "unknown"}`;
}
