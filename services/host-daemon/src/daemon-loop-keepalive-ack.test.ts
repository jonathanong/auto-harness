import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEEPALIVE_ACK_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { DaemonLoop } from "./daemon-loop.ts";
import { flushMicrotasks, makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
import { createLoopbackTransport } from "./loopback-transport.ts";

const STALL_MS = 45_000;

async function startStallLoop() {
  const { config, cleanup } = await makeRepo();
  const loopback = createLoopbackTransport({ sendToServer: () => undefined });
  let negotiate: ((protocolVersion?: number) => void) | undefined;
  const forceReconnectCalls: string[] = [];
  const stallArms: Array<() => void> = [];
  const loop = new DaemonLoop({
    config,
    transport: {
      ...loopback,
      onRegistered(handler: (protocolVersion?: number) => void) {
        negotiate = handler;
      },
      forceReconnect(reason: string) {
        forceReconnectCalls.push(reason);
      },
    },
    keepaliveStallMs: STALL_MS,
    timers: {
      setTimeout: (callback, ms) => {
        if (ms === STALL_MS) stallArms.push(callback as () => void);
        return stallArms.length as never;
      },
      clearTimeout: () => undefined,
    },
  });
  await loop.start();
  return { cleanup, config, loop, loopback, negotiate, stallArms, forceReconnectCalls };
}

describe("DaemonLoop keepalive ack watchdog", () => {
  it("does not re-arm on send after protocol 2 negotiation until keepalive-ack", async () => {
    const harness = await startStallLoop();
    try {
      const afterStart = harness.stallArms.length;
      expect(afterStart).toBeGreaterThan(0);
      harness.negotiate?.(KEEPALIVE_ACK_PROTOCOL_VERSION);
      const afterRegistered = harness.stallArms.length;
      expect(afterRegistered).toBe(afterStart + 1);

      await harness.loop.keepalive();
      expect(harness.stallArms.length).toBe(afterRegistered);

      harness.loopback.deliver({
        type: "host:keepalive-ack",
        hostId: harness.config.hostId,
        at: "now",
      });
      await flushMicrotasks();
      expect(harness.stallArms.length).toBe(afterRegistered + 1);

      harness.loopback.deliver({
        type: "host:keepalive-ack",
        hostId: "other-host",
        at: "now",
      });
      await flushMicrotasks();
      expect(harness.stallArms.length).toBe(afterRegistered + 1);

      harness.stallArms.at(-1)?.();
      expect(harness.forceReconnectCalls).toEqual([`no successful keepalive in ${STALL_MS}ms`]);
      harness.loop.stop();
    } finally {
      harness.cleanup();
    }
  });

  it("does not re-arm on a protocol-2 readiness re-register until host:registered", async () => {
    const { config, cleanup } = await makeRepo();
    const root = mkdtempSync(join(tmpdir(), "ah-keepalive-ack-home-"));
    const home = join(root, "acct");
    mkdirSync(home);
    const profiles: ExecutionProfiles = {
      maxConcurrentAssignments: 1,
      profiles: new Map([["acct", { providerAccountId: "acct", home, env: {} }]]),
    };
    const loopback = createLoopbackTransport({ sendToServer: () => undefined });
    let negotiate: ((protocolVersion?: number) => void) | undefined;
    const stallArms: Array<() => void> = [];
    const loop = new DaemonLoop({
      config,
      transport: {
        ...loopback,
        onRegistered(handler: (protocolVersion?: number) => void) {
          negotiate = handler;
        },
      },
      executionProfiles: profiles,
      keepaliveStallMs: STALL_MS,
      timers: {
        setTimeout: (callback, ms) => {
          if (ms === STALL_MS) stallArms.push(callback as () => void);
          return stallArms.length as never;
        },
        clearTimeout: () => undefined,
      },
    });
    try {
      await loop.start();
      negotiate?.(KEEPALIVE_ACK_PROTOCOL_VERSION);
      const afterRegistered = stallArms.length;
      rmSync(home, { recursive: true, force: true });
      await loop.keepalive();
      expect(stallArms.length).toBe(afterRegistered);
      loop.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  });

  it("keeps send-based re-arm when host:registered omits protocolVersion", async () => {
    const harness = await startStallLoop();
    try {
      harness.negotiate?.();
      const afterRegistered = harness.stallArms.length;
      await harness.loop.keepalive();
      expect(harness.stallArms.length).toBe(afterRegistered + 1);
      harness.loop.stop();
    } finally {
      harness.cleanup();
    }
  });
});
