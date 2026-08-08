import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HOST_KEEPALIVE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_USAGE_LIMIT_RETRY_CEILING,
  LOCAL_HOST_ID,
  LOCAL_API_HTTP,
  ON_CONFLICT_OPTIONS,
  PACKAGE_SCOPE,
  SESSION_ERROR_CODES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
} from "./constants.ts";

describe("constants", () => {
  it("exports stable product constants", () => {
    expect(PACKAGE_SCOPE).toBe("@auto-harness");
    expect(DEFAULT_USAGE_LIMIT_RETRY_CEILING).toBe(2);
    expect(DEFAULT_QUEUE_SHARD_COUNT).toBe(4);
    expect(DEFAULT_ACK_DEADLINE_MS).toBeGreaterThan(0);
    expect(DEFAULT_HEARTBEAT_STALE_MS).toBeLessThan(DEFAULT_ACK_DEADLINE_MS * 100);
    expect(DEFAULT_HOST_KEEPALIVE_MS).toBeGreaterThan(0);
    expect(DEFAULT_ARCHIVE_PREFIX).toContain("session");
    expect(SESSION_STATUSES).toContain("queued");
    expect(TERMINAL_SESSION_STATUSES).not.toContain("queued");
    expect(SESSION_ERROR_CODES).toContain("usage_limit");
    expect(ON_CONFLICT_OPTIONS).toEqual(["queue", "replace", "reject"]);
    expect(LOCAL_HOST_ID).toBe("local-1");
    expect(LOCAL_API_HTTP).toContain("7420");
  });
});
