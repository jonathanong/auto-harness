import { describe, expect, it, vi } from "vitest";

import {
  createDeferredTerminalHookSettlement,
  retainClaimForDeferredTerminalHook,
} from "./deferred-terminal-hook.ts";

describe("retainClaimForDeferredTerminalHook", () => {
  it("collects a result without a configured hook, baseline, or child environment", async () => {
    const run = vi.fn(async () => ({ exitCode: 1, timedOut: false, signal: null }));
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "session" } as never,
      claimed: {
        currentHookTarget: async () => ({ cwd: process.cwd(), repository: {} }),
      },
      status: "failed",
      errorCode: undefined,
      childEnvSource: process.env,
      environmentIsChild: true,
    });

    await expect(settle(true)).resolves.toEqual({
      summary: "Session failed",
      summarySource: "harness",
    });
    expect(run).toHaveBeenCalled();
  });

  it("does not start a hook or result probe after a recovery deadline", async () => {
    const run = vi.fn();
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "session" } as never,
      claimed: {
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "/hook.sh" },
        }),
      },
      status: "failed",
      errorCode: undefined,
      childEnvSource: process.env,
      environmentIsChild: true,
    });

    await expect(settle(true, Date.now() - 1)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not start a hook when its lease expires during checkout revalidation", async () => {
    const run = vi.fn();
    const deadlineAtMs = Date.now() + 1_000;
    let finishRevalidation!: () => void;
    const revalidation = new Promise<void>((resolve) => {
      finishRevalidation = resolve;
    });
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "session" } as never,
      claimed: {
        currentHookTarget: async () => {
          await revalidation;
          return { cwd: process.cwd(), repository: { terminalHookScript: "/hook.sh" } };
        },
      },
      status: "failed",
      errorCode: undefined,
      childEnvSource: process.env,
      environmentIsChild: true,
    });

    const pending = settle(true, deadlineAtMs);
    vi.spyOn(Date, "now").mockReturnValue(deadlineAtMs);
    try {
      finishRevalidation();
      await expect(pending).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not start a hook if its lease expires after revalidation", async () => {
    const run = vi.fn();
    const deadlineAtMs = Date.now() + 1_000;
    const now = vi.spyOn(Date, "now");
    now
      .mockReturnValueOnce(deadlineAtMs - 2)
      .mockReturnValueOnce(deadlineAtMs - 1)
      .mockReturnValueOnce(deadlineAtMs);
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "session" } as never,
      claimed: {
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "/hook.sh" },
        }),
      },
      status: "failed",
      errorCode: undefined,
      childEnvSource: process.env,
      environmentIsChild: true,
    });

    try {
      await expect(settle(true, deadlineAtMs)).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("bounds hook execution and result collection by the recovery deadline", async () => {
    const run = vi.fn(async () => ({ exitCode: 1, timedOut: false, signal: null }));
    const settle = createDeferredTerminalHookSettlement({
      processRunner: { run },
      streamer: { write: vi.fn() } as never,
      assign: { sessionId: "session" } as never,
      claimed: {
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "/hook.sh" },
        }),
      },
      status: "failed",
      errorCode: undefined,
      childEnvSource: process.env,
      environmentIsChild: true,
    });
    const deadlineAtMs = Date.now() + 10_000;

    await expect(settle(true, deadlineAtMs)).resolves.toEqual({
      summary: "Session failed",
      summarySource: "harness",
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(run.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(10_000);
  });

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

  it("shares an in-progress settlement with a concurrent caller", async () => {
    const release = vi.fn();
    let hookStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    let finishHook!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishHook = resolve;
    });
    const settle = vi.fn(async () => {
      hookStarted();
      await blocked;
      return { summary: "post-hook result", summarySource: "harness" as const };
    });
    const retained = retainClaimForDeferredTerminalHook(
      {
        status: "failed",
        exitCode: null,
        logs: [],
        settleDeferredTerminalHook: settle,
      },
      release,
    );

    const first = retained.settleDeferredTerminalHook!(true);
    await started;
    const duplicate = retained.settleDeferredTerminalHook!(true);
    expect(duplicate).toBe(first);
    expect(settle).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    finishHook();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { summary: "post-hook result", summarySource: "harness" },
      { summary: "post-hook result", summarySource: "harness" },
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
