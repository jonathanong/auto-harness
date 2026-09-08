import { describe, expect, it } from "vitest";

import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import {
  NOW,
  busyWorktreeFixture,
  runningSessionFixture,
  seedConnectedHost,
} from "./control-plane-keepalive-reconcile-test-helpers.ts";

describe("keepalive-driven session reconciliation", () => {
  it("requeues a session the daemon no longer reports as running", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = runningSessionFixture();
    const worktree = busyWorktreeFixture();
    let requeueOptions: Record<string, unknown> | undefined;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listActiveSessionsByHost: async () => [session],
      getWorktree: async () => worktree,
      tryRequeueSession: async (opts: Record<string, unknown>) => {
        requeueOptions = opts;
        return true;
      },
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: [] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    expect(requeueOptions).toMatchObject({
      sessionId: "s",
      reason: "daemon no longer reports session as running; requeued",
    });
  });

  it("requests reassignment immediately after a keepalive-driven requeue", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = runningSessionFixture();
    const worktree = busyWorktreeFixture();
    let sweptQueue = 0;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listActiveSessionsByHost: async () => [session],
      getWorktree: async () => worktree,
      tryRequeueSession: async () => true,
      listSessionsByStatusPage: async () => {
        sweptQueue += 1;
        return [];
      },
      listConnections: async () => [],
      listHostInventories: async () => [],
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: [] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    // Otherwise the recovered session sits queued until the next cron sweep
    // instead of being redispatched as soon as reconciliation frees it.
    expect(sweptQueue).toBeGreaterThan(0);
  });

  it("leaves a session alone when the keepalive still reports it as running", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = runningSessionFixture();
    const worktree = busyWorktreeFixture();
    let requeued = false;
    let worktreeReads = 0;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listActiveSessionsByHost: async () => [session],
      getWorktree: async () => {
        worktreeReads += 1;
        return worktree;
      },
      tryRequeueSession: async () => {
        requeued = true;
        return true;
      },
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: ["s"] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    expect(requeued).toBe(false);
    // A session the daemon already reports as running must not cost a
    // per-worktree storage read: on a healthy host with many concurrent
    // sessions, that is the common case on every 20s keepalive.
    expect(worktreeReads).toBe(0);
  });
});
