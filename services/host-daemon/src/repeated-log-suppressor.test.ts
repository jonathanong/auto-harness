import { describe, expect, it } from "vitest";

import { RepeatedLogSuppressor } from "./repeated-log-suppressor.ts";

describe("RepeatedLogSuppressor", () => {
  it("always logs the first message", () => {
    let now = 0;
    const suppressor = new RepeatedLogSuppressor({ minIntervalMs: 1_000, nowMs: () => now });
    expect(suppressor.next("boom")).toBe("boom");
  });

  it("suppresses immediate repeats of the same message", () => {
    let now = 0;
    const suppressor = new RepeatedLogSuppressor({ minIntervalMs: 1_000, nowMs: () => now });
    expect(suppressor.next("boom")).toBe("boom");
    now += 10;
    expect(suppressor.next("boom")).toBeUndefined();
    now += 10;
    expect(suppressor.next("boom")).toBeUndefined();
  });

  it("logs a different message immediately, even mid-suppression", () => {
    let now = 0;
    const suppressor = new RepeatedLogSuppressor({ minIntervalMs: 1_000, nowMs: () => now });
    expect(suppressor.next("boom")).toBe("boom");
    now += 10;
    expect(suppressor.next("boom")).toBeUndefined();
    expect(suppressor.next("bang")).toBe("bang");
  });

  it("emits a reminder with a repeat count once minIntervalMs has elapsed", () => {
    let now = 0;
    const suppressor = new RepeatedLogSuppressor({ minIntervalMs: 1_000, nowMs: () => now });
    expect(suppressor.next("boom")).toBe("boom");
    for (let i = 0; i < 5; i++) {
      now += 100;
      expect(suppressor.next("boom")).toBeUndefined();
    }
    now += 500;
    expect(suppressor.next("boom")).toBe("boom (repeated 5 time(s) since last log)");
  });

  it("resets the repeat count after emitting a reminder", () => {
    let now = 0;
    const suppressor = new RepeatedLogSuppressor({ minIntervalMs: 1_000, nowMs: () => now });
    suppressor.next("boom");
    now += 1_000;
    // No occurrences were suppressed in between, so no "(repeated N)" suffix.
    expect(suppressor.next("boom")).toBe("boom");
    now += 200;
    expect(suppressor.next("boom")).toBeUndefined();
    now += 800;
    expect(suppressor.next("boom")).toBe("boom (repeated 1 time(s) since last log)");
  });

  it("returns a fresh message with no suffix after switching away and back", () => {
    let now = 0;
    const suppressor = new RepeatedLogSuppressor({ minIntervalMs: 1_000, nowMs: () => now });
    suppressor.next("boom");
    now += 10;
    suppressor.next("boom");
    now += 10;
    expect(suppressor.next("bang")).toBe("bang");
    now += 10;
    expect(suppressor.next("boom")).toBe("boom");
  });
});
