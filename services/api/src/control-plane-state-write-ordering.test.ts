import { describe, expect, it } from "vitest";

import { createControlPlaneState, queueWrite, settleStorage } from "./control-plane-state.ts";

describe("queued durable writes", () => {
  it("starts lazily in invocation order", async () => {
    const state = createControlPlaneState();
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queueWrite(state, async () => {
      started.push("first");
      await firstDone;
    });
    queueWrite(state, async () => {
      started.push("second");
    });

    expect(started).toEqual([]);
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    releaseFirst?.();
    await settleStorage(state);
    expect(started).toEqual(["first", "second"]);
  });

  it("reports a failed write while allowing following writes to continue", async () => {
    const state = createControlPlaneState();
    const started: string[] = [];

    queueWrite(state, async () => {
      started.push("failed");
      throw new Error("durable write failed");
    });
    queueWrite(state, async () => {
      started.push("continued");
    });

    await expect(settleStorage(state)).rejects.toThrow("durable write failed");
    expect(started).toEqual(["failed", "continued"]);
    await expect(settleStorage(state)).resolves.toBeUndefined();
  });
});
