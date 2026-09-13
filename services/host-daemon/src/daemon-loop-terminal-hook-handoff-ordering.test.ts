/* eslint-disable max-lines -- terminal handoff reservation, capacity, and fail-closed variants share one fixture. */
import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture,
} from "../test-helpers/daemon-loop-test-helpers.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

function worktreeTarget(repositoryId = "demo", worktreeId = "wt-1"): string {
  return `worktree\0${repositoryId}\0${worktreeId}`;
}

describe("DaemonLoop terminal-hook handoff ordering", () => {
  it("reserves a handoff target before reconciliation so a racing assignment cannot overtake it", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: () => undefined,
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      let finishHook!: (result: { summary: string; summarySource: "harness" }) => void;
      pendingTerminalStatusOf(loop).set("lost\\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "lost", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: () =>
          new Promise((resolve) => {
            finishHook = resolve;
          }),
      } as never);
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async () => {
        assignmentStarted();
      };
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await flushMacrotask();
      expect(
        (
          loop as unknown as { worktreeAssignmentTails: Map<string, Promise<void>> }
        ).worktreeAssignmentTails.has(worktreeTarget()),
      ).toBe(true);
      expect(
        (
          loop as unknown as { pendingTerminalHookHandoffs: Map<string, { reconciling: boolean }> }
        ).pendingTerminalHookHandoffs.get("handoff")?.reconciling,
      ).toBe(true);

      transport.deliver({
        type: "session:assign",
        sessionId: "next",
        attemptId: "attempt-next",
        repositoryId: "demo",
        prompt: "next",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(assignmentStarted).not.toHaveBeenCalled();
      finishHook({ summary: "after hook", summarySource: "harness" });
      await waitFor(() => assignmentStarted.mock.calls.length === 1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("keeps a capacity-queued handoff reserved and starts it before later work on that target", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: () => undefined,
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      let finishAssignment!: () => void;
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async (msg: {
        sessionId: string;
      }) => {
        assignmentStarted(msg.sessionId);
        if (msg.sessionId === "blocker") {
          await new Promise<void>((resolve) => {
            finishAssignment = resolve;
          });
        }
      };
      let finishHook!: (result: { exitCode: number }) => void;
      const hookStarted = vi.fn();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: (options: { argv: string[] }) => {
          if (options.argv[0] === "/bin/sh") {
            hookStarted();
            return new Promise((resolve) => {
              finishHook = resolve;
            });
          }
          return Promise.resolve({ exitCode: 0 });
        },
      };
      transport.deliver({
        type: "session:assign",
        sessionId: "blocker",
        attemptId: "attempt-blocker",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "block",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await waitFor(() => assignmentStarted.mock.calls.some(([id]) => id === "blocker"));
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "queued",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await waitFor(() =>
        (
          loop as unknown as { pendingTerminalHookHandoffs: Map<string, { executing: boolean }> }
        ).pendingTerminalHookHandoffs.has("queued"),
      );
      expect(
        (
          loop as unknown as { pendingTerminalHookHandoffs: Map<string, { executing: boolean }> }
        ).pendingTerminalHookHandoffs.get("queued")?.executing,
      ).toBe(false);
      expect(
        (
          loop as unknown as { worktreeAssignmentTails: Map<string, Promise<void>> }
        ).worktreeAssignmentTails.has(worktreeTarget()),
      ).toBe(true);

      transport.deliver({
        type: "session:assign",
        sessionId: "overtake",
        attemptId: "attempt-overtake",
        repositoryId: "demo",
        prompt: "next",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(assignmentStarted.mock.calls.flat()).toEqual(["blocker"]);
      expect(hookStarted).not.toHaveBeenCalled();

      finishAssignment();
      await waitFor(() => hookStarted.mock.calls.length === 1);
      expect(assignmentStarted.mock.calls.flat()).toEqual(["blocker"]);
      finishHook({ exitCode: 0 });
      await waitFor(
        () =>
          (loop as unknown as { activeTerminalHookHandoffs: number }).activeTerminalHookHandoffs ===
          0,
      );
      transport.deliver({
        type: "session:assign",
        sessionId: "overtake",
        attemptId: "attempt-overtake-retry",
        repositoryId: "demo",
        prompt: "next",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await waitFor(() => assignmentStarted.mock.calls.some(([id]) => id === "overtake"));
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("admits an assignment on another target while a handoff is only reconciling", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: () => undefined,
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      pendingTerminalStatusOf(loop).set("lost\\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "lost", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: () => new Promise(() => undefined),
      } as never);
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async () => {
        assignmentStarted();
      };
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await flushMacrotask();
      transport.deliver({
        type: "session:assign",
        sessionId: "other",
        attemptId: "attempt-other",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "other",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await waitFor(() => assignmentStarted.mock.calls.length === 1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not start a parked assignment until an executing handoff on another target releases capacity", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({
        sendToServer: () => undefined,
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async () => {
        assignmentStarted();
      };
      let finishHook!: (result: { exitCode: number }) => void;
      const hookStarted = vi.fn();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: (options: { argv: string[] }) => {
          if (options.argv[0] === "/bin/sh") {
            hookStarted();
            return new Promise((resolve) => {
              finishHook = resolve;
            });
          }
          return Promise.resolve({ exitCode: 0 });
        },
      };
      transport.deliver({
        type: "session:assign",
        sessionId: "parked",
        attemptId: "attempt-parked",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "parked",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await waitFor(() =>
        [
          ...(
            loop as unknown as { inflight: Map<string, { executing: boolean }> }
          ).inflight.values(),
        ].some((entry) => !entry.executing),
      );
      expect(assignmentStarted).not.toHaveBeenCalled();

      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "other-target",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await waitFor(() => hookStarted.mock.calls.length === 1);

      transport.deliver({
        type: "session:acknowledged",
        sessionId: "parked",
        attemptId: "attempt-parked",
      });
      for (let attempt = 0; attempt < 10; attempt += 1) await flushMacrotask();
      expect(assignmentStarted).not.toHaveBeenCalled();

      finishHook({ exitCode: 0 });
      await waitFor(() => assignmentStarted.mock.calls.length === 1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("aborts a capacity wait without starting the parked assignment", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({
        sendToServer: () => undefined,
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async () => {
        assignmentStarted();
      };
      let finishHook!: (result: { exitCode: number }) => void;
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: (options: { argv: string[] }) => {
          if (options.argv[0] === "/bin/sh") {
            return new Promise((resolve) => {
              finishHook = resolve;
            });
          }
          return Promise.resolve({ exitCode: 0 });
        },
      };
      transport.deliver({
        type: "session:assign",
        sessionId: "parked",
        attemptId: "attempt-parked",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "parked",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await waitFor(
        () => (loop as unknown as { inflight: Map<string, unknown> }).inflight.size === 1,
      );
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "other-target",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await waitFor(
        () =>
          (loop as unknown as { activeTerminalHookHandoffs: number }).activeTerminalHookHandoffs ===
          1,
      );
      transport.deliver({
        type: "session:acknowledged",
        sessionId: "parked",
        attemptId: "attempt-parked",
      });
      await waitFor(
        () =>
          (loop as unknown as { executionCapacityWaiters: Set<unknown> }).executionCapacityWaiters
            .size === 1,
      );
      transport.deliver({
        type: "session:cancel",
        sessionId: "parked",
        attemptId: "attempt-parked",
      });
      await waitFor(
        () => (loop as unknown as { inflight: Map<string, unknown> }).inflight.size === 0,
      );
      finishHook({ exitCode: 0 });
      await waitFor(
        () =>
          (loop as unknown as { activeTerminalHookHandoffs: number }).activeTerminalHookHandoffs ===
          0,
      );
      expect(assignmentStarted).not.toHaveBeenCalled();
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("sends a harness fallback when checkout revalidation, hook, or result probe fail closed", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      const worktrees = loop as unknown as {
        worktrees: {
          claim(): Promise<{ currentHookTarget(): Promise<null> }>;
          release(): void;
        };
      };
      worktrees.worktrees.claim = async () => ({
        currentHookTarget: async () => null,
      });
      worktrees.worktrees.release = () => undefined;
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "missing-checkout",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "checkout_fetch_failed",
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "missing-checkout",
        ),
      );
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "lost",
        handoffId: "missing-checkout",
        result: { summary: "Session failed", summarySource: "harness" },
      });

      const internals = loop as unknown as {
        runTerminalHookHandoff(pending: object): Promise<void>;
        runTerminalHookForClaim(): Promise<undefined>;
      };
      internals.runTerminalHookForClaim = async () => {
        throw new Error("hook exploded");
      };
      const hookFailed = {
        message: {
          type: "session:terminal-hook" as const,
          handoffId: "hook-failed",
          sessionId: "lost",
          repositoryId: "demo",
          worktreeId: "wt-1",
          status: "failed" as const,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      };
      await internals.runTerminalHookHandoff(hookFailed);
      expect(hookFailed).toMatchObject({
        complete: true,
        result: { summary: "Session failed", summarySource: "harness" },
      });

      internals.runTerminalHookForClaim = async () => undefined;
      const probeFailed = {
        message: {
          type: "session:terminal-hook" as const,
          handoffId: "probe-failed",
          sessionId: "lost",
          repositoryId: "demo",
          worktreeId: "wt-1",
          status: "cancelled" as const,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      };
      await internals.runTerminalHookHandoff(probeFailed);
      expect(probeFailed.result).toEqual({
        summary: "Session cancelled",
        summarySource: "harness",
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
