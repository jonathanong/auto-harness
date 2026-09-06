import { describe, expect, it, vi } from "vitest";

import { withTimeout } from "./with-timeout.ts";

describe("withTimeout", () => {
  it("resolves with the promise's value when it settles before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1_000, "too slow")).resolves.toBe("done");
  });

  it("rejects with the promise's own error when it rejects before the deadline", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000, "too slow")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with the timeout message when the promise never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<never>(() => {});
      const result = withTimeout(pending, 1_000, "timed out waiting");
      const assertion = expect(result).rejects.toThrow("timed out waiting");
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer once the promise settles, using an injected timers seam", async () => {
    let cleared = false;
    const fakeTimer = { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    const timers = {
      setTimeout: (() => fakeTimer) as typeof setTimeout,
      clearTimeout: ((timer: unknown) => {
        if (timer === fakeTimer) cleared = true;
      }) as typeof clearTimeout,
    };
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "too slow", timers)).resolves.toBe("ok");
    expect(cleared).toBe(true);
  });
});
