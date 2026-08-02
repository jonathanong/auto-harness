import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_USAGE_LIMIT_RETRY_CEILING,
  ON_CONFLICT_OPTIONS,
  PACKAGE_SCOPE,
  SESSION_ERROR_CODES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
} from "./constants.js";

describe("constants", () => {
  it("exports stable product constants", () => {
    expect(PACKAGE_SCOPE).toBe("@auto-harness");
    expect(DEFAULT_USAGE_LIMIT_RETRY_CEILING).toBe(2);
    expect(DEFAULT_QUEUE_SHARD_COUNT).toBe(4);
    expect(SESSION_STATUSES).toContain("queued");
    expect(TERMINAL_SESSION_STATUSES).not.toContain("queued");
    expect(SESSION_ERROR_CODES).toContain("usage_limit");
    expect(ON_CONFLICT_OPTIONS).toEqual(["queue", "replace", "reject"]);
  });
});
