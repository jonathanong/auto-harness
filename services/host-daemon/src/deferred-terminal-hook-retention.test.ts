import { describe, expect, it, vi } from "vitest";

import { retainClaimForDeferredTerminalHook } from "./deferred-terminal-hook.ts";

describe("retainClaimForDeferredTerminalHook", () => {
  it("returns the post-hook result before releasing the retained checkout", async () => {
    const release = vi.fn();
    const settle = vi.fn(async () => ({
      summary: "after hook",
      summarySource: "harness" as const,
    }));
    const retained = retainClaimForDeferredTerminalHook(
      {
        status: "failed",
        exitCode: null,
        logs: [],
        settleDeferredTerminalHook: settle,
      },
      release,
    );

    await expect(retained.settleDeferredTerminalHook?.(true)).resolves.toEqual({
      summary: "after hook",
      summarySource: "harness",
    });
    expect(release).toHaveBeenCalledOnce();
    await expect(retained.settleDeferredTerminalHook?.(true)).resolves.toBeUndefined();
    expect(settle).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
