import { describe, expect, it } from "vitest";

import { AgentLoop, createLoopbackTransport } from "./agent-loop.ts";
import { makeRepo } from "./agent-loop-test-helpers.ts";

describe("AgentLoop drain", () => {
  it("drain refuses new assigns without killing inflight tracking", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: () => {
          /* ignore */
        },
      });
      const loop = new AgentLoop({
        config,
        transport,
        onLog: (l) => {
          logs.push(l);
        },
        isDraining: () => false,
      });
      await loop.start();
      loop.beginDrain();
      expect(loop.isDraining()).toBe(true);
      transport.deliver({ type: "agent:drain" });
      transport.deliver({
        type: "session:assign",
        sessionId: "sess-x",
        repositoryId: "demo",
        prompt: "x",
        resolvedArgv: ["printf", "%s", "x"],
        timeout: 10,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();
      expect(loop.inflightCount()).toBe(0);
      expect(logs.some((l) => l.includes("draining"))).toBe(true);
      transport.deliver({ type: "session:cancel", sessionId: "sess-x" });
      expect(logs.some((l) => l.includes("cancel"))).toBe(true);
      // unknown wire type ignored
      transport.deliver({ type: "ping" } as never);
      loop.stop();

      // external isDraining predicate
      const transport3 = createLoopbackTransport({ sendToServer: () => undefined });
      let drainFlag = false;
      const loop3 = new AgentLoop({
        config,
        transport: transport3,
        isDraining: () => drainFlag,
      });
      await loop3.start();
      expect(loop3.isDraining()).toBe(false);
      drainFlag = true;
      expect(loop3.isDraining()).toBe(true);
      loop3.stop();
    } finally {
      cleanup();
    }
  });
});
