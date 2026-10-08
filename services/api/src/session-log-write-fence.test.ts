import { afterEach, describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { assertSessionLogWritesAllowed } from "./session-log-write-fence.ts";

describe("session log write fence", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a retention read that outlives its bounded freshness window", async () => {
    vi.useFakeTimers();
    const state = createControlPlaneState({
      storage: {
        getSessionRetentionStore: () => ({ getSession: () => new Promise(() => undefined) }),
      } as never,
    });

    const check = assertSessionLogWritesAllowed(state, "session");
    const rejection = expect(check).rejects.toThrow("session log write fence check timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("rejects a check whose result arrives after the freshness window", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(11_001);
    const state = createControlPlaneState({
      storage: {
        getSessionRetentionStore: () => ({ getSession: async () => ({ id: "session" }) }),
      } as never,
    });

    await expect(assertSessionLogWritesAllowed(state, "session")).rejects.toThrow(
      "session log write fence check timed out",
    );
    now.mockRestore();
  });
});
