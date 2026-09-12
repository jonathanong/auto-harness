/* eslint-disable max-lines -- existing coverage table for daemon loop branches. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";
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
});
