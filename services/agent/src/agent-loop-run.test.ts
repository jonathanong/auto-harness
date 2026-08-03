import { describe, expect, it } from "vitest";

import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";

import { AgentLoop, createLoopbackTransport } from "./agent-loop.ts";
import { makeRepo } from "./agent-loop-test-helpers.ts";

describe("AgentLoop run", () => {
  it("registers, acks, runs profile, reports terminal status and logs", async () => {
    const { config, cleanup } = makeRepo();
    try {
      const serverMsgs: AgentToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const loop = new AgentLoop({ config, transport });
      await loop.start();
      expect(serverMsgs.some((m) => m.type === "agent:register")).toBe(true);

      const assign: AgentWireMessage = {
        type: "session:assign",
        sessionId: "sess-loop",
        repositoryId: "demo",
        prompt: "hello-loop",
        commandProfile: "echo-prompt",
        timeout: 30,
        worktreeId: "wt-1",
        ref: "main",
        assignedAt: new Date().toISOString(),
      };
      transport.deliver(assign);
      await loop.waitForIdle();

      expect(serverMsgs.some((m) => m.type === "session:ack")).toBe(true);
      expect(serverMsgs.some((m) => m.type === "session:status" && m.status === "completed")).toBe(
        true,
      );
      expect(serverMsgs.some((m) => m.type === "session:log")).toBe(true);

      await loop.keepalive();
      expect(serverMsgs.some((m) => m.type === "agent:keepalive")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
