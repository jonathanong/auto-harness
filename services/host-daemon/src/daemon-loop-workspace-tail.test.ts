import { describe, expect, it } from "vitest";
import type { HostWireMessage } from "@auto-harness/shared";
import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

function workspaceAssignment(
  sessionId: string,
  slotId: string,
): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId,
    attemptId: `attempt-${sessionId}`,
    sessionType: "workspace",
    repositoryId: null,
    prompt: sessionId,
    resolvedArgv: ["true"],
    timeout: 30,
    worktreeId: null,
    workspacePoolId: "pool",
    workspaceSlotId: slotId,
    assignedAt: new Date().toISOString(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop workspace assignment tails", () => {
  it("runs assignments for distinct workspace slots concurrently", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 2, profiles: new Map() },
      });
      const started: string[] = [];
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const second = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      (
        loop as unknown as {
          runAssign(assign: { sessionId: string }): Promise<void>;
        }
      ).runAssign = async (assign) => {
        started.push(assign.sessionId);
        await (assign.sessionId === "first" ? first : second);
      };

      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 0 });
      transport.deliver(workspaceAssignment("first", "slot-one"));
      transport.deliver(workspaceAssignment("second", "slot-two"));

      await waitFor(() => started.length === 2);
      expect(started).toEqual(expect.arrayContaining(["first", "second"]));
      releaseFirst();
      releaseSecond();
      await loop.waitForIdle();
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("serializes assignments for the same workspace slot", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 2, profiles: new Map() },
      });
      const started: string[] = [];
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const second = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      (
        loop as unknown as {
          runAssign(assign: { sessionId: string }): Promise<void>;
        }
      ).runAssign = async (assign) => {
        started.push(assign.sessionId);
        await (assign.sessionId === "first" ? first : second);
      };

      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 0 });
      transport.deliver(workspaceAssignment("first", "slot-one"));
      await waitFor(() => started.length === 1);
      transport.deliver(workspaceAssignment("second", "slot-one"));
      await flushMacrotask();
      expect(started).toEqual(["first"]);
      releaseFirst();
      await waitFor(() => started.length === 2);
      releaseSecond();
      await loop.waitForIdle();
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
