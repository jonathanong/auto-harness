/* eslint-disable max-lines -- existing coverage table for daemon loop branches. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture,
} from "../test-helpers/daemon-loop-test-helpers.ts";
import { SpawnProcessRunner, type ProcessRunner } from "./executor.ts";

type Inflight = {
  sessionId: string;
  attemptId: string;
  controller: AbortController;
  work: Promise<void>;
  acknowledged: boolean;
};

type LoopInternals = {
  inflight: Map<string, Inflight>;
  handleServerMessage(message: HostWireMessage): Promise<void>;
  waitForAcknowledgement(
    sessionId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
};

function attemptIdFor(sessionId: string): string {
  return `attempt-${sessionId}`;
}

function assign(sessionId: string): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId,
    attemptId: attemptIdFor(sessionId),
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

function terminalHandoff(sessionId: string, worktreeId: string | null) {
  return {
    type: "session:terminal-hook" as const,
    handoffId: `${sessionId}-handoff`,
    sessionId,
    repositoryId: "demo",
    worktreeId,
    status: "failed" as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function coverageAssignment(sessionId: string) {
  return {
    type: "session:assign" as const,
    sessionId,
    attemptId: `attempt-${sessionId}`,
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["true"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop coverage guards", () => {
  it("logs complete scheduler route metadata before executing", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const home = mkdtempSync(join(tmpdir(), "ah-profile-"));
      mkdirSync(home, { recursive: true });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
        executionProfiles: {
          maxConcurrentAssignments: 4,
          profiles: new Map([["account-1", { providerAccountId: "account-1", home, env: {} }]]),
        },
      });
      await loop.start();
      transport.deliver({
        ...assign("routed"),
        targetIndex: 0,
        commandId: "command-1",
        providerAccountId: "account-1",
      });
      transport.deliver({ ...assign("provider-only"), providerAccountId: "account-1" });
      transport.deliver({ ...assign("command-only"), commandId: "command-1" });
      await loop.waitForIdle();
      expect(lines).toContain(
        "resolved route for routed: target=0 command=command-1 providerAccount=account-1",
      );
      expect(lines).toContain(
        "resolved route for provider-only: target=? providerAccount=account-1",
      );
      expect(lines).toContain("resolved route for command-only: target=? command=command-1");
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("handles listener and acknowledgement races without starting duplicate work", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const rejectedTransport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:ack") throw new Error("offline");
        },
      });
      const unloggedLoop = new DaemonLoop({ config, transport: rejectedTransport });
      await unloggedLoop.start();
      rejectedTransport.deliver(assign("listener-error"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unloggedLoop.inflightCount()).toBe(0);
      unloggedLoop.stop();

      const primitiveLines: string[] = [];
      const primitiveTransport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:ack") throw "primitive offline";
        },
      });
      const primitiveLoop = new DaemonLoop({
        config,
        transport: primitiveTransport,
        onLog: (line) => primitiveLines.push(line),
      });
      await primitiveLoop.start();
      primitiveTransport.deliver(assign("primitive-error"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(primitiveLines).toContain("server message failed: primitive offline");
      primitiveLoop.stop();

      const lines: string[] = [];
      let markAcknowledged: (() => void) | undefined;
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
        onLog: (line) => lines.push(line),
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        timers: {
          setTimeout: () => {
            markAcknowledged?.();
            return 0 as never;
          },
          clearTimeout: () => undefined,
        },
      });
      const internals = loop as unknown as LoopInternals;
      const raced: Inflight = {
        sessionId: "raced",
        attemptId: attemptIdFor("raced"),
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      };
      internals.inflight.set(`raced\0${raced.attemptId}`, raced);
      markAcknowledged = () => {
        raced.acknowledged = true;
      };
      await expect(
        internals.waitForAcknowledgement("raced", raced.attemptId, raced.controller.signal),
      ).resolves.toBe(true);

      internals.inflight.set(`early\0${attemptIdFor("early")}`, {
        sessionId: "early",
        attemptId: attemptIdFor("early"),
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      });
      internals.inflight.set(`duplicate\0${attemptIdFor("duplicate")}`, {
        sessionId: "duplicate",
        attemptId: attemptIdFor("duplicate"),
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: true,
      });
      await internals.handleServerMessage({
        type: "session:acknowledged",
        sessionId: "early",
        attemptId: attemptIdFor("early"),
      });
      await internals.handleServerMessage(assign("duplicate"));
      expect(lines).toContain("duplicate assign ignored for duplicate attempt attempt-duplicate");
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("logs primitive drain retry failures and cancels the scheduled retry on stop", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      for (const failure of [new Error("error offline"), "primitive offline"]) {
        const failureMessage = failure instanceof Error ? failure.message : failure;
        let retry: (() => void) | undefined;
        let cleared = false;
        const lines: string[] = [];
        const transport = createLoopbackTransport({
          sendToServer: (message) => {
            if (message.type === "host:status") throw failure;
          },
        });
        const loop = new DaemonLoop({
          config,
          transport,
          onLog: (line) => lines.push(line),
          timers: {
            // Several timers now share this seam (drain retry, drain deadline,
            // the keepalive-stall watchdog armed on every successful
            // register()). Filter by delay to isolate the short drain-retry
            // interval from the much longer deadline/watchdog ones — a bare
            // "first call wins" would just as easily capture whichever of
            // those fires during loop.start()'s initial registration.
            setTimeout: (callback, ms) => {
              if ((ms ?? 0) <= 5_000) retry ??= callback;
              return 1 as never;
            },
            clearTimeout: () => {
              cleared = true;
            },
          },
        });
        await loop.start();
        void loop.beginDrain();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lines).toContain(`drain notification failed: ${failureMessage}`);
        retry?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lines).toContain(`drain notification retry failed: ${failureMessage}`);
        loop.stop();
        expect(cleared).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("logs and forces a reconnect when the keepalive stall timer actually fires", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      let stall: (() => void) | undefined;
      const forceReconnectCalls: string[] = [];
      const lines: string[] = [];
      const loopback = createLoopbackTransport({ sendToServer: () => undefined });
      const transport = {
        ...loopback,
        forceReconnect: (reason: string) => forceReconnectCalls.push(reason),
      };
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
        keepaliveStallMs: 45_000,
        timers: {
          // start() arms the stall timer directly after the initial register(),
          // with no other long-delay timer competing for this seam at that point.
          setTimeout: (callback) => {
            stall ??= callback as () => void;
            return 1 as never;
          },
          clearTimeout: () => undefined,
        },
      });
      await loop.start();
      expect(stall).toBeDefined();
      stall?.();
      expect(lines).toContain("no successful keepalive in 45000ms; forcing reconnect");
      expect(forceReconnectCalls).toEqual(["no successful keepalive in 45000ms"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("confirms a matching drain advertisement and cancels every inflight attempt", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
      });
      await loop.start();
      const internals = loop as unknown as LoopInternals;
      const controller = new AbortController();
      internals.inflight.set("session-1\0attempt-1", {
        sessionId: "session-1",
        attemptId: "attempt-1",
        controller,
        work: Promise.resolve(),
        acknowledged: true,
      });
      await internals.handleServerMessage({ type: "host:draining", hostId: config.hostId });
      expect(loop.isDraining()).toBe(true);
      await internals.handleServerMessage({ type: "session:cancel", sessionId: "session-1" });
      expect(controller.signal.aborted).toBe(true);
      expect(lines.some((line) => line.includes("cancel requested for session-1"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not drop a replacement inflight slot when the original assignment ends", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const fallback = new SpawnProcessRunner();
      let releaseCommand: (() => void) | undefined;
      const commandStarted = Promise.withResolvers<void>();
      const processRunner: ProcessRunner = {
        async run(options) {
          const argv0 = options.argv[0] ?? "";
          if (argv0.includes("printf") || options.argv.includes("%s")) {
            commandStarted.resolve();
            await new Promise<void>((resolve, reject) => {
              releaseCommand = resolve;
              options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            }).catch(() => ({ exitCode: 1, timedOut: false, cancelled: true, signal: null }));
            return { exitCode: 1, timedOut: false, cancelled: true, signal: null };
          }
          return fallback.run(options);
        },
      };
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport, processRunner });
      await loop.start();
      const internals = loop as unknown as LoopInternals;
      const pending = internals.handleServerMessage(assign("keep-slot"));
      await commandStarted.promise;
      const key = `keep-slot\0${attemptIdFor("keep-slot")}`;
      const original = internals.inflight.get(key)!;
      const replacement: Inflight = {
        sessionId: "keep-slot",
        attemptId: attemptIdFor("keep-slot"),
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      };
      internals.inflight.set(key, replacement);
      original.controller.abort();
      await pending;
      expect(internals.inflight.get(key)).toBe(replacement);
      releaseCommand?.();
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("covers deferred cleanup failures and target-fence races", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
        pendingStatusMaxAgeMs: 0,
      });
      await loop.start();
      const internals = loop as unknown as {
        handleServerMessage(message: HostWireMessage): Promise<void>;
        retryPendingTerminalStatuses(): void;
        waitForTargetFence(targetWork: Promise<void>, signal: AbortSignal): Promise<boolean>;
        prepareForShutdown(): void;
        pendingTerminalStatus: Map<string, unknown>;
      };
      const pending = pendingTerminalStatusOf(loop);
      const prepareHook = vi.fn();
      pending.set("prepare\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "prepare", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: prepareHook,
      } as never);
      internals.prepareForShutdown();
      await loop.waitForIdle();
      expect(prepareHook).not.toHaveBeenCalled();

      const stopHook = vi.fn();
      pending.set("stop\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "stop", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: stopHook,
      } as never);
      loop.stop();
      expect(stopHook).not.toHaveBeenCalled();

      const aborted = new AbortController();
      aborted.abort();
      await expect(
        internals.waitForTargetFence(new Promise<void>(() => undefined), aborted.signal),
      ).resolves.toBe(false);

      let reads = 0;
      const racingSignal = {
        get aborted() {
          reads += 1;
          return reads > 1;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as AbortSignal;
      await expect(
        internals.waitForTargetFence(new Promise<void>(() => undefined), racingSignal),
      ).resolves.toBe(false);
      await expect(
        internals.waitForTargetFence(
          Promise.reject(new Error("prior target failed")),
          new AbortController().signal,
        ),
      ).resolves.toBe(true);

      // Exercise both expiry cleanup branches, including a primitive rejection.
      const deferredResolve = vi.fn();
      const ordinaryResolve = vi.fn();
      pending.set("expired-deferred\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "expired-deferred", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now() - 1,
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => {
          throw "expired primitive";
        },
        resolveDeferredDisposition: deferredResolve,
      } as never);
      pending.set("expired-ordinary\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "expired-ordinary", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now() - 1,
        sending: false,
        controller: new AbortController(),
        resolveDeferredDisposition: ordinaryResolve,
      } as never);
      internals.retryPendingTerminalStatuses();
      await flushMacrotask();
      expect(deferredResolve).toHaveBeenCalledOnce();
      expect(ordinaryResolve).toHaveBeenCalledOnce();
      expect(lines).toContain(
        "deferred terminal hook failed for expired-deferred: expired primitive",
      );
    } finally {
      cleanup();
    }
  });

  it("covers terminal status handoff construction, reuse, and reconciliation", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      const internals = loop as unknown as {
        handleServerMessage(message: HostWireMessage): Promise<void>;
        serverProtocolVersion: number;
        pendingTerminalHookHandoffs: Map<string, { complete: boolean; result?: unknown }>;
        reconcilePendingTerminalStatusForHandoff(sessionId: string): Promise<unknown>;
      };
      const pending = pendingTerminalStatusOf(loop);
      const result = { summary: "hook result", summarySource: "harness" as const };
      internals.serverProtocolVersion = 4;
      await internals.handleServerMessage({
        type: "session:terminal-hook",
        handoffId: "old-protocol",
        sessionId: "old-protocol",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      internals.serverProtocolVersion = 7;
      pending.set("constructed\0attempt", {
        message: {
          ...terminalStatusFixture,
          sessionId: "constructed",
          attemptId: "attempt",
          errorCode: "checkout_fetch_failed",
        },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => result,
      } as never);
      await internals.handleServerMessage({
        type: "session:status-acknowledged",
        sessionId: "constructed",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "constructed-handoff",
        terminalHookHandoffExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "constructed",
        handoffId: "constructed-handoff",
        result,
      });

      pending.set("constructed-empty\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "constructed-empty", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => undefined,
      } as never);
      await internals.handleServerMessage({
        type: "session:status-acknowledged",
        sessionId: "constructed-empty",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "constructed-empty-handoff",
        terminalHookHandoffExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      internals.pendingTerminalHookHandoffs.set("existing-handoff", {
        message: terminalHandoff("existing", "wt-1"),
        firstAttemptedAtMs: Date.now(),
        complete: true,
        sending: false,
        result: undefined,
      });
      pending.set("existing\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "existing", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => {
          pending.delete("existing\0attempt");
          return result;
        },
      } as never);
      await internals.handleServerMessage({
        type: "session:status-acknowledged",
        sessionId: "existing",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "existing-handoff",
        terminalHookHandoffExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(internals.pendingTerminalHookHandoffs.get("existing-handoff")?.result).toEqual(result);

      internals.pendingTerminalHookHandoffs.set("existing-empty-handoff", {
        message: terminalHandoff("existing-empty", "wt-1"),
        firstAttemptedAtMs: Date.now(),
        complete: true,
        sending: false,
      });
      pending.set("existing-empty\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "existing-empty", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => undefined,
      } as never);
      await internals.handleServerMessage({
        type: "session:status-acknowledged",
        sessionId: "existing-empty",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "existing-empty-handoff",
        terminalHookHandoffExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      await internals.handleServerMessage({
        type: "session:terminal-hook",
        handoffId: "existing-handoff",
        sessionId: "existing",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      internals.pendingTerminalHookHandoffs.set("incomplete-handoff", { complete: false });
      await internals.handleServerMessage({
        type: "session:terminal-hook",
        handoffId: "incomplete-handoff",
        sessionId: "incomplete",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      pending.set("reconciled\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "reconciled", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => result,
      } as never);
      await internals.handleServerMessage({
        type: "session:terminal-hook",
        handoffId: "reconciled-handoff",
        sessionId: "reconciled",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(sent).toContainEqual(
        expect.objectContaining({ handoffId: "reconciled-handoff", result }),
      );
      pending.set("reconciled-empty\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "reconciled-empty", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        resolveDeferredDisposition: vi.fn(),
      } as never);
      await internals.handleServerMessage({
        type: "session:terminal-hook",
        handoffId: "reconciled-empty-handoff",
        sessionId: "reconciled-empty",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
      });

      await internals.handleServerMessage({
        type: "session:status-acknowledged",
        sessionId: "unknown",
        attemptId: "missing",
      });

      const ordinaryResolve = vi.fn();
      pending.set("ordinary\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "ordinary", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        resolveDeferredDisposition: ordinaryResolve,
      } as never);
      await expect(internals.reconcilePendingTerminalStatusForHandoff("ordinary")).resolves.toEqual(
        {
          matched: true,
        },
      );
      expect(ordinaryResolve).toHaveBeenCalledOnce();
      await expect(internals.reconcilePendingTerminalStatusForHandoff("absent")).resolves.toEqual({
        matched: false,
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("covers handoff target claims, result forwarding, and completion retry failures", async () => {
    const { config, cleanup, root } = await makeRepo();
    try {
      let failCompletion = false;
      const lines: string[] = [];
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:terminal-hook-complete" && failCompletion)
            throw new Error("completion offline");
          sent.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => lines.push(line) });
      await loop.start();
      const internals = loop as unknown as {
        runTerminalHookHandoff(pending: {
          message: Extract<HostWireMessage, { type: "session:terminal-hook" }>;
          expiresAtMs?: number;
          firstAttemptedAtMs?: number;
          complete: boolean;
          executing: boolean;
          sending: boolean;
          result?: unknown;
        }): Promise<void>;
        runTerminalHookForClaim(
          message: Extract<HostWireMessage, { type: "session:terminal-hook" }>,
          claim: { currentHookTarget: () => Promise<unknown> },
        ): Promise<unknown>;
        retryPendingTerminalHookHandoffs(): void;
        pendingTerminalHookHandoffs: Map<string, { complete: boolean; sending: boolean }>;
        worktreeAssignmentTails: Map<string, Promise<void>>;
        worktrees: unknown;
        processRunner: unknown;
      };
      const releaseMain = vi.fn();
      const releaseWorktree = vi.fn();
      const claim = {
        currentHookTarget: async () => ({
          cwd: config.repositories[0]!.path,
          repository: config.repositories[0]!,
          allowedRoots: [root],
        }),
      };
      internals.worktrees = {
        acquireMain: async () => true,
        mainClaim: async () => claim,
        releaseMain,
        claim: async () => claim,
        release: releaseWorktree,
      };
      // A rejected predecessor is still a completed target fence.
      internals.worktreeAssignmentTails.set(
        "worktree\0demo\0wt-1",
        Promise.reject(new Error("previous target failed")),
      );
      (
        loop as unknown as { runTerminalHookForClaim: () => Promise<undefined> }
      ).runTerminalHookForClaim = async () => undefined;
      const failedPredecessor = {
        message: terminalHandoff("rejected-predecessor", "wt-1"),
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      };
      await internals.runTerminalHookHandoff(failedPredecessor);

      (
        loop as unknown as { runTerminalHookForClaim: () => Promise<unknown> }
      ).runTerminalHookForClaim = async () => ({
        summary: "main result",
        summarySource: "harness" as const,
      });
      const mainPending = {
        message: terminalHandoff("main-result", null),
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      };
      await internals.runTerminalHookHandoff(mainPending);
      const worktreePending = {
        message: terminalHandoff("worktree-result", "wt-1"),
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      };
      await internals.runTerminalHookHandoff(worktreePending);
      (
        loop as unknown as { runTerminalHookForClaim: () => Promise<undefined> }
      ).runTerminalHookForClaim = async () => undefined;
      const emptyResultPending = {
        message: terminalHandoff("empty-result", null),
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      };
      await internals.runTerminalHookHandoff(emptyResultPending);
      expect(mainPending.result).toEqual({ summary: "main result", summarySource: "harness" });
      expect(worktreePending.result).toEqual({ summary: "main result", summarySource: "harness" });
      expect(releaseMain).toHaveBeenCalledWith("demo");
      expect(releaseWorktree).toHaveBeenCalledWith("wt-1");

      (
        loop as unknown as { runTerminalHookForClaim: typeof internals.runTerminalHookForClaim }
      ).runTerminalHookForClaim = (
        DaemonLoop.prototype as unknown as {
          runTerminalHookForClaim: typeof internals.runTerminalHookForClaim;
        }
      ).runTerminalHookForClaim.bind(loop);
      const noCurrent = await internals.runTerminalHookForClaim(
        terminalHandoff("no-current", "wt-1"),
        {
          currentHookTarget: async () => null,
        },
      );
      expect(noCurrent).toBeUndefined();
      const noScriptRepository = { ...config.repositories[0]! };
      delete noScriptRepository.terminalHookScript;
      const noScriptResult = await internals.runTerminalHookForClaim(
        terminalHandoff("no-script", "wt-1"),
        {
          currentHookTarget: async () => ({
            cwd: config.repositories[0]!.path,
            repository: noScriptRepository,
          }),
        },
      );
      expect(noScriptResult).toMatchObject({ summarySource: "harness" });
      const hookRuns: string[][] = [];
      internals.processRunner = {
        run: async (options: {
          argv: string[];
          onChunk?: (chunk: { stream: string; data: string }) => void;
        }) => {
          hookRuns.push(options.argv);
          if (options.argv[0] !== "/bin/sh")
            options.onChunk?.({ stream: "stdout", data: "main\n" });
          return {
            exitCode: options.argv[0] === "/bin/sh" ? 0 : 1,
            timedOut: false,
            signal: null,
          };
        },
      };
      const actualResult = await internals.runTerminalHookForClaim(
        {
          ...terminalHandoff("actual-hook", "wt-1"),
          errorCode: "host_lost",
          ref: "refs/heads/main",
          metadata: { source: "test" },
        },
        claim,
      );
      expect(actualResult).toMatchObject({ summary: "Session failed", summarySource: "harness" });
      expect(hookRuns[0]?.[0]).toBe("/bin/sh");
      expect(hookRuns[0]?.[1]).toContain("hook.sh");
      await internals.runTerminalHookForClaim(
        { ...terminalHandoff("actual-no-error", "wt-1"), ref: "refs/heads/main" },
        claim,
      );

      const retryable = {
        message: terminalHandoff("retryable", "wt-1"),
        firstAttemptedAtMs: Date.now(),
        complete: true,
        sending: false,
      };
      internals.pendingTerminalHookHandoffs.set("retryable-handoff", retryable);
      internals.retryPendingTerminalHookHandoffs();
      failCompletion = true;
      const failed = {
        message: terminalHandoff("failed-completion", "wt-1"),
        firstAttemptedAtMs: Date.now(),
        complete: true,
        sending: false,
      };
      internals.pendingTerminalHookHandoffs.set("failed-completion-handoff", failed);
      // A second retry attempts the now-failing completion write.
      internals.retryPendingTerminalHookHandoffs();
      await flushMacrotask();
      internals.pendingTerminalHookHandoffs.set("incomplete-handoff", {
        message: terminalHandoff("incomplete-retry", "wt-1"),
        firstAttemptedAtMs: Date.now(),
        complete: false,
        executing: true,
        sending: false,
      });
      internals.retryPendingTerminalHookHandoffs();
      expect(lines).toContain(
        "terminal hook handoff completion send failed for failed-completion: completion offline",
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("covers assignment authorization cancellation and shutdown terminal conversion", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      let acknowledge = false;
      let abortAssignment: (() => void) | undefined;
      const sent: HostToServerMessage[] = [];
      let transport!: ReturnType<typeof createLoopbackTransport>;
      transport = createLoopbackTransport({
        sendToServer: (message) => {
          sent.push(message);
          if (acknowledge && message.type === "session:ack") {
            transport.deliver({
              type: "session:acknowledged",
              sessionId: message.sessionId,
              attemptId: message.attemptId,
            });
            if (message.sessionId === "aborted-before-run") {
              abortAssignment?.();
            }
          }
        },
      });
      const loop = new DaemonLoop({ config, transport, ackConfirmationMs: 0 });
      await loop.start();
      const internals = loop as unknown as {
        serverProtocolVersion: number;
        runner: unknown;
        inflight: Map<string, { controller: AbortController }>;
        pendingTerminalStatus: Map<string, unknown>;
        handleAssign(message: Extract<HostWireMessage, { type: "session:assign" }>): Promise<void>;
        acknowledgeAssignment(
          message: Extract<HostWireMessage, { type: "session:assign" }>,
          signal: AbortSignal,
        ): Promise<boolean>;
        runAssign(
          message: Extract<HostWireMessage, { type: "session:assign" }>,
          signal: AbortSignal,
        ): Promise<void>;
        settleDeferredOnCompletion: boolean;
        supportsSessionResult: boolean;
      };
      abortAssignment = () =>
        internals.inflight
          .get("aborted-before-run\0attempt-aborted-before-run")
          ?.controller.abort();
      internals.serverProtocolVersion = 4;
      await internals.handleAssign(coverageAssignment("ack-timeout"));
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "session:ack", sessionId: "ack-timeout" }),
      );

      internals.serverProtocolVersion = 0;
      let releaseSuperseded!: () => void;
      const superseded = new Promise<void>((resolve) => {
        releaseSuperseded = resolve;
      });
      internals.pendingTerminalStatus.set("replacement\0old", {
        message: { ...terminalStatusFixture, sessionId: "replacement", attemptId: "old" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async () => await superseded,
      });
      const replacement = internals.handleAssign(coverageAssignment("replacement"));
      for (let i = 0; i < 20 && !internals.inflight.has("replacement\0attempt-replacement"); i += 1)
        await flushMacrotask();
      internals.inflight.get("replacement\0attempt-replacement")?.controller.abort();
      await replacement;
      releaseSuperseded();

      acknowledge = true;
      internals.runner = {
        run: async () => ({ status: "completed", exitCode: 0, logs: [] }),
      };
      await internals.handleAssign(coverageAssignment("normal"));
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "session:status", sessionId: "normal" }),
      );
      await internals.handleAssign(coverageAssignment("aborted-before-run"));
      expect(
        sent.filter(
          (message) =>
            message.type === "session:status" && message.sessionId === "aborted-before-run",
        ),
      ).toHaveLength(0);
      (
        loop as unknown as {
          acknowledgeAssignment: typeof internals.acknowledgeAssignment;
        }
      ).acknowledgeAssignment = async (message) => {
        internals.inflight.get(`${message.sessionId}\0${message.attemptId}`)?.controller.abort();
        return true;
      };
      await internals.handleAssign(coverageAssignment("aborted-after-ack"));

      internals.serverProtocolVersion = 6;
      internals.settleDeferredOnCompletion = true;
      internals.supportsSessionResult = true;
      let returnResult = true;
      internals.runner = {
        run: async () => ({
          status: "failed",
          exitCode: null,
          logs: [],
          errorCode: returnResult ? "checkout_fetch_failed" : "setup_failed",
          settleDeferredTerminalHook: async () => {
            if (returnResult)
              return { summary: "shutdown result", summarySource: "harness" as const };
            throw "shutdown primitive";
          },
        }),
      };
      await internals.runAssign(
        coverageAssignment("shutdown-result"),
        new AbortController().signal,
      );
      returnResult = false;
      await internals.runAssign(coverageAssignment("shutdown-error"), new AbortController().signal);
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "session:status",
          sessionId: "shutdown-result",
          errorCode: "checkout_fetch_failed",
          deferTerminalHookResult: true,
        }),
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
