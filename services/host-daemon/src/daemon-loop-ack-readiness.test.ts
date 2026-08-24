import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";

describe("DaemonLoop readiness registration", () => {
  it("waits for a pending ACK before re-registering changed account readiness", async () => {
    const { config, cleanup } = await makeRepo();
    const root = mkdtempSync(join(tmpdir(), "ah-pending-ack-home-"));
    const home = join(root, "acct");
    mkdirSync(home);
    const profiles: ExecutionProfiles = {
      maxConcurrentAssignments: 1,
      profiles: new Map([["acct", { providerAccountId: "acct", home, env: {} }]]),
    };
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void serverMsgs.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: profiles,
        now: () => "now",
      });
      await loop.start();
      const inflight = (
        loop as unknown as {
          inflight: Map<
            string,
            {
              sessionId: string;
              attemptId: string;
              controller: AbortController;
              work: Promise<void>;
              acknowledged: boolean;
            }
          >;
        }
      ).inflight;
      inflight.set("pending-ack\0attempt-pending", {
        sessionId: "pending-ack",
        attemptId: "attempt-pending",
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      });

      rmSync(home, { recursive: true, force: true });
      await loop.keepalive();
      expect(serverMsgs.at(-1)).toEqual({
        type: "host:keepalive",
        hostId: config.hostId,
        at: "now",
      });
      expect(serverMsgs.filter((message) => message.type === "host:register")).toHaveLength(1);

      transport.deliver({
        type: "session:acknowledged",
        sessionId: "pending-ack",
        attemptId: "attempt-pending",
      });
      await Promise.resolve();
      await loop.keepalive();
      expect(serverMsgs.at(-1)).toMatchObject({
        type: "host:register",
        runningAttempts: [{ sessionId: "pending-ack", attemptId: "attempt-pending" }],
        providerAccountReadiness: [{ providerAccountId: "acct", ready: false }],
      });
      loop.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
      cleanup();
    }
  });
});
