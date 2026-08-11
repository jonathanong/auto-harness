import { describe, expect, it } from "vitest";

import { isValidUtcTimestamp, nextCronOccurrence, parseCron } from "./cron.ts";

describe("strict UTC cron", () => {
  it("validates UTC timestamps without accepting normalized dates", () => {
    expect(isValidUtcTimestamp("2026-01-01T00:00:00Z")).toBe(true);
    expect(isValidUtcTimestamp("2026-02-29T00:00:00.000Z")).toBe(false);
    expect(isValidUtcTimestamp("2024-02-29T00:00:00.123Z")).toBe(true);
    expect(isValidUtcTimestamp("2026-01-01T00:00:00+00:00")).toBe(false);
    expect(isValidUtcTimestamp("not-a-timestamp")).toBe(false);
  });

  it("supports wildcards, lists, ranges, and steps", () => {
    const after = "2026-01-01T05:59:45.000Z";
    expect(nextCronOccurrence("* * * * *", after)).toBe("2026-01-01T06:00:00.000Z");
    expect(nextCronOccurrence("0 6 * * *", after)).toBe("2026-01-01T06:00:00.000Z");
    expect(nextCronOccurrence("0,30 6-8/2 * * *", after)).toBe("2026-01-01T06:00:00.000Z");
    expect(nextCronOccurrence("*/15 6 * * *", after)).toBe("2026-01-01T06:00:00.000Z");
    expect(nextCronOccurrence("5 6 * * *", "2026-01-01T06:05:00.000Z")).toBe(
      "2026-01-02T06:05:00.000Z",
    );
  });

  it("uses standard day-of-month/day-of-week cron semantics in UTC", () => {
    expect(nextCronOccurrence("0 0 13 * 1", "2026-01-12T00:00:00.000Z")).toBe(
      "2026-01-13T00:00:00.000Z",
    );
    expect(nextCronOccurrence("0 0 * * 1", "2026-01-13T00:00:00.000Z")).toBe(
      "2026-01-19T00:00:00.000Z",
    );
    expect(nextCronOccurrence("0 0 */1 * 1", "2026-01-13T00:00:00.000Z")).toBe(
      "2026-01-19T00:00:00.000Z",
    );
    expect(nextCronOccurrence("0 0 13 * */1", "2026-01-13T00:00:00.000Z")).toBe(
      "2026-02-13T00:00:00.000Z",
    );
  });

  it("rejects malformed, out-of-range, and impossible expressions", () => {
    for (const cron of [
      "* * * *",
      "* 24 * * *",
      "*/0 * * * *",
      "*/2/3 * * * *",
      "*/ * * * *",
      "1- * * * *",
      "1/2 * * * *",
      "x * * * *",
      "9007199254740992 * * * *",
      "0 0 * * 7",
      "0 0 * * * extra",
    ]) {
      expect(parseCron(cron)).toBeNull();
      expect(nextCronOccurrence(cron, "2026-01-01T00:00:00.000Z")).toBeNull();
    }
    expect(parseCron("0 0 31 2 *")).not.toBeNull();
    expect(nextCronOccurrence("0 0 31 2 *", "2026-01-01T00:00:00.000Z")).toBeNull();
    expect(nextCronOccurrence("* * * * *", "invalid")).toBeNull();
  });

  it("bounds impossible calendar expressions without scanning years of minutes", () => {
    const started = performance.now();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(nextCronOccurrence("0 0 31 2 *", "2026-01-01T00:00:00.000Z")).toBeNull();
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("skips dates that match neither constrained day field", () => {
    expect(nextCronOccurrence("0 0 13 * 1", "2026-01-13T00:00:00.000Z")).toBe(
      "2026-01-19T00:00:00.000Z",
    );
  });
});
