import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { AgentLoop, createLoopbackTransport } from "./agent-loop.ts";
import { makeRepo } from "./agent-loop-test-helpers.ts";

describe("AgentLoop run", () => {
  it("registers, acks, runs profile, reports terminal status and logs", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const loop = new AgentLoop({ config, transport });
      await loop.start();
      expect(serverMsgs.some((m) => m.type === "host:register")).toBe(true);

      const assign: HostWireMessage = {
        type: "session:assign",
        sessionId: "sess-loop",
        repositoryId: "demo",
        prompt: "hello-loop",
        resolvedArgv: ["printf", "%s", "hello-loop"],
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
      expect(serverMsgs.some((m) => m.type === "host:keepalive")).toBe(true);

      const registersBefore = serverMsgs.filter((m) => m.type === "host:register").length;
      await loop.applyInventory({
        ...config,
        commandProfiles: {
          ...config.commandProfiles,
          true: { argv: ["true"], appendPrompt: false },
        },
      });
      expect(serverMsgs.filter((m) => m.type === "host:register").length).toBe(registersBefore + 1);

      loop.stop();
    } finally {
      cleanup();
    }
  });
});
