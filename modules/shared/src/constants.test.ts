import { describe, expect, it } from "vitest";

import {
  ACTIVE_SESSION_STATUSES,
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HOST_KEEPALIVE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_TTL_SECONDS,
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS,
  LOCAL_HOST_ID,
  LOCAL_API_HTTP,
  HOST_PROTOCOL_VERSION,
  ATTEMPT_FENCED_PROTOCOL_VERSION,
  MAX_SESSION_LOG_DROPPED,
  PACKAGE_SCOPE,
  SESSION_ERROR_CODES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  USER_ROLES,
  WORKTREE_STATUSES,
} from "./constants.ts";

describe("constants", () => {
  it("exports stable product constants", () => {
    expect(PACKAGE_SCOPE).toBe("@auto-harness");
    expect(DEFAULT_QUEUE_TTL_SECONDS).toBe(691_200);
    expect(DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS).toBe(18_000);
    expect(DEFAULT_QUEUE_SHARD_COUNT).toBe(4);
    expect(DEFAULT_ACK_DEADLINE_MS).toBeGreaterThan(0);
    expect(DEFAULT_HEARTBEAT_STALE_MS).toBeLessThan(DEFAULT_ACK_DEADLINE_MS * 100);
    expect(DEFAULT_HOST_KEEPALIVE_MS).toBeGreaterThan(0);
    expect(DEFAULT_ARCHIVE_PREFIX).toBe("sessions/");
    expect(SESSION_STATUSES).toContain("queued");
    expect(TERMINAL_SESSION_STATUSES).not.toContain("queued");
    expect(ACTIVE_SESSION_STATUSES).toEqual(["queued", "running"]);
    expect(SESSION_ERROR_CODES).toContain("usage_limit");
    expect(USER_ROLES).toEqual(["read-only", "author", "operator", "maintainer", "agent", "admin"]);
    expect(WORKTREE_STATUSES).toEqual(["idle", "busy", "error"]);
    expect(LOCAL_HOST_ID).toBe("local-1");
    expect(LOCAL_API_HTTP).toContain("7420");
    expect(HOST_PROTOCOL_VERSION).toBe(1);
    expect(ATTEMPT_FENCED_PROTOCOL_VERSION).toBe(1);
    expect(HOST_PROTOCOL_VERSION).toBeGreaterThanOrEqual(ATTEMPT_FENCED_PROTOCOL_VERSION);
    expect(MAX_SESSION_LOG_DROPPED).toBe(1_000_000);
  });
});
