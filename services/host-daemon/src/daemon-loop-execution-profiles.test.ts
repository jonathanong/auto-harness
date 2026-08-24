import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
import { executionProfileFingerprint } from "./execution-profiles.ts";
import type { ProcessRunner } from "./executor.ts";

function assign(over: Partial<Extract<HostWireMessage, { type: "session:assign" }>>) {
  return {
    type: "session:assign" as const,
    sessionId: "sess",
    attemptId: "attempt",
    repositoryId: "demo",
    prompt: "p",
    resolvedArgv: ["printf", "%s", "ok"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
    ...over,
  };
}

describe("DaemonLoop execution profiles", () => {
  it("refuses an assignment when the exact account profile is unavailable", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          serverMsgs.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver(assign({ providerAccountId: "missing-account" }));
      await loop.waitForIdle();
      expect(serverMsgs.some((message) => message.type === "session:ack")).toBe(false);
      expect(
        serverMsgs.some(
          (message) =>
            message.type === "host:register" &&
            Array.isArray(message.providerAccountReadiness) &&
            message.providerAccountReadiness.length === 0,
        ),
      ).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("logs and refuses a ready assignment whose account profile is missing", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({ sendToServer: () => undefined }),
        onLog: (line) => lines.push(line),
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      await loop.start();
      await (
        loop as unknown as {
          handleServerMessage(message: HostWireMessage): Promise<void>;
        }
      ).handleServerMessage(assign({ sessionId: "missing-ready", providerAccountId: "missing" }));
      expect(lines).toContain(
        "execution profile unavailable: refused assign missing-ready account missing",
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("runs two accounts with isolated local CLI homes", async () => {
    const { config, cleanup } = await makeRepo();
    const root = mkdtempSync(join(tmpdir(), "ah-homes-"));
    const homeA = join(root, "a");
    const homeB = join(root, "b");
    mkdirSync(homeA);
    mkdirSync(homeB);
    const profiles: ExecutionProfiles = {
      maxConcurrentAssignments: 2,
      profiles: new Map([
        ["acct-a", { providerAccountId: "acct-a", home: homeA, env: {} }],
        ["acct-b", { providerAccountId: "acct-b", home: homeB, env: {} }],
      ]),
    };
    const homes: string[] = [];
    const commandRunner: ProcessRunner = {
      async run(options) {
        homes.push(options.env?.HOME ?? "");
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          serverMsgs.push(message);
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        commandRunner,
        executionProfiles: profiles,
      });
      await loop.start();
      const register = serverMsgs.find((message) => message.type === "host:register");
      expect(register).toMatchObject({
        capabilities: {
          features: ["scheduled-main-checkout"],
          maxConcurrentAssignments: 2,
        },
        providerAccountReadiness: [
          {
            providerAccountId: "acct-a",
            ready: true,
            fingerprint: executionProfileFingerprint(profiles.profiles.get("acct-a")!),
          },
          {
            providerAccountId: "acct-b",
            ready: true,
            fingerprint: executionProfileFingerprint(profiles.profiles.get("acct-b")!),
          },
        ],
      });
      transport.deliver(assign({ sessionId: "s-a", attemptId: "a1", providerAccountId: "acct-a" }));
      await loop.waitForIdle();
      transport.deliver(assign({ sessionId: "s-b", attemptId: "a2", providerAccountId: "acct-b" }));
      await loop.waitForIdle();
      expect(homes).toEqual([homeA, homeB]);
      rmSync(homeA, { recursive: true, force: true });
      await loop.keepalive();
      expect(serverMsgs.at(-1)).toMatchObject({
        type: "host:register",
        providerAccountReadiness: [
          { providerAccountId: "acct-a", ready: false },
          { providerAccountId: "acct-b", ready: true },
        ],
      });
      mkdirSync(homeA);
      await loop.keepalive();
      expect(serverMsgs.at(-1)).toMatchObject({
        type: "host:register",
        providerAccountReadiness: [
          { providerAccountId: "acct-a", ready: true },
          { providerAccountId: "acct-b", ready: true },
        ],
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("refuses assignments beyond the advertised concurrent assignment cap", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({ sendToServer: () => undefined }),
        onLog: (line) => lines.push(line),
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const inflight = (loop as unknown as { inflight: Map<string, unknown> }).inflight;
      inflight.set("active-0", {
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: true,
      });
      await (
        loop as unknown as {
          handleServerMessage(message: HostWireMessage): Promise<void>;
        }
      ).handleServerMessage(assign({ sessionId: "over-capacity", attemptId: "a-over" }));
      expect(lines).toContain("session capacity reached: refused assign over-capacity");
    } finally {
      cleanup();
    }
  });
});
