import type { IncomingMessage, ServerResponse } from "node:http";

import { auditActor } from "./audit.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { LocalServerOptions } from "./local-http.ts";
import { send } from "./local-http.ts";
import {
  clientSourceKey,
  limitFor,
  MemoryRateLimiter,
  rateLimitStorageKey,
  retryAfterSeconds,
  type RateLimitBucket,
  type RateLimitConfig,
  type RateLimitDecision,
} from "./rate-limit.ts";

export type RateLimitContext = {
  config: RateLimitConfig;
  memoryLimiter: MemoryRateLimiter;
  now: () => number;
  options: LocalServerOptions;
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  principal?: import("./auth.ts").Principal;
  bucket: RateLimitBucket;
  trustProxy: boolean;
};

/** Returns true when the request has been answered (429 or durable failure). */
export async function enforceRateLimit(ctx: RateLimitContext): Promise<boolean> {
  if (!ctx.config.enabled) return false;
  const nowMs = ctx.now();
  const actorKey = ctx.principal
    ? `${ctx.principal.kind}:${ctx.principal.id}`
    : clientSourceKey(ctx.req, ctx.trustProxy);
  const limit = limitFor(ctx.config, ctx.bucket);
  let decision: RateLimitDecision;
  try {
    const durable =
      ctx.plane.state.storage?.rateLimitStore === true
        ? ctx.plane.state.storage.consumeRateLimit
        : undefined;
    decision = durable
      ? await durable.call(ctx.plane.state.storage, {
          actorKey,
          bucket: ctx.bucket,
          limit,
          windowSeconds: ctx.config.windowSeconds,
          nowMs,
        })
      : ctx.memoryLimiter.consume(
          `${ctx.bucket}\0${actorKey}`,
          limit,
          ctx.config.windowSeconds,
          nowMs,
        );
  } catch {
    ctx.options.onRateLimitEvent?.({
      outcome: "error",
      bucket: ctx.bucket,
      limit,
      actorKey: rateLimitStorageKey(actorKey, ctx.bucket),
    });
    if (ctx.config.failMode === "open") return false;
    const resetAtMs = nowMs + ctx.config.windowSeconds * 1000;
    setRateLimitHeaders(ctx.res, { allowed: false, limit, remaining: 0, resetAtMs }, nowMs);
    send(ctx.res, 503, {
      error: { code: "RATE_LIMIT_UNAVAILABLE", message: "rate limit service unavailable" },
    });
    return true;
  }
  const safeActorKey = rateLimitStorageKey(actorKey, ctx.bucket);
  ctx.options.onRateLimitEvent?.({
    outcome: decision.allowed ? "allowed" : "denied",
    bucket: ctx.bucket,
    limit: decision.limit,
    remaining: decision.remaining,
    resetAtMs: decision.resetAtMs,
    actorKey: safeActorKey,
  });
  setRateLimitHeaders(ctx.res, decision, nowMs);
  if (decision.allowed) return false;
  const retryAfter = retryAfterSeconds(decision.resetAtMs, nowMs);
  if (ctx.method !== "GET" && ctx.method !== "HEAD" && ctx.method !== "OPTIONS") {
    try {
      await ctx.plane.appendAuditLog({
        actor: auditActor(ctx.principal),
        action: "rate-limit:deny",
        resourceType: "route",
        resourceId: `${ctx.method} ${ctx.pathname}`,
        outcome: "denied",
        metadata: { bucket: ctx.bucket, limit: decision.limit, retryAfterSeconds: retryAfter },
      });
    } catch {
      // A denied request must remain denied even when the audit backend is down.
      // The event hook records the operational failure without request data.
      ctx.options.onRateLimitEvent?.({
        outcome: "error",
        bucket: ctx.bucket,
        limit,
        actorKey: safeActorKey,
      });
    }
  }
  ctx.res.setHeader?.("Retry-After", retryAfter);
  send(ctx.res, 429, { error: { code: "RATE_LIMITED", message: "too many requests" } });
  return true;
}

function setRateLimitHeaders(
  res: ServerResponse,
  decision: RateLimitDecision,
  nowMs: number,
): void {
  res.setHeader?.("X-RateLimit-Limit", decision.limit);
  res.setHeader?.("X-RateLimit-Remaining", decision.remaining);
  res.setHeader?.("X-RateLimit-Reset", Math.ceil(decision.resetAtMs / 1000));
  if (!decision.allowed)
    res.setHeader?.("Retry-After", retryAfterSeconds(decision.resetAtMs, nowMs));
}
