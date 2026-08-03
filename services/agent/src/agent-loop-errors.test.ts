import { describe, expect, it } from "vitest";

import type { AgentToServerMessage } from "@auto-harness/shared";

import { AgentLoop, createLoopbackTransport } from "./agent-loop.ts";
import { makeRepo } from "./agent-loop-test-helpers.ts";

describe("AgentLoop errors", () => {
  it("rejects unknown profile without shell spawn success", async () => {
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
      transport.deliver({
        type: "session:assign",
        sessionId: "sess-bad",
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "does-not-exist",
        timeout: 10,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();
      const status = serverMsgs.find((m) => m.type === "session:status");
      expect(status?.type === "session:status" && status.status).toBe("failed");
      expect(status?.type === "session:status" && status.errorCode).toBe("unknown_command_profile");
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("maps optional assign fields and runner throw to setup_failed", async () => {
    const { config, cleanup } = makeRepo();
    try {
      const serverMsgs: AgentToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const { SpawnProcessRunner } = await import("./executor.ts");
      const real = new SpawnProcessRunner();
      let profileSpawns = 0;
      const loop = new AgentLoop({
        config,
        transport,
        onLog: () => undefined,
        processRunner: {
          async run(opts) {
            // git/setup use real spawn; only the profile argv fails hard
            if (opts.argv[0] === "printf") {
              profileSpawns += 1;
              throw new Error("runner boom");
            }
            return real.run(opts);
          },
        },
      });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "sess-opt",
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "echo-prompt",
        timeout: 10,
        worktreeId: "wt-1",
        ref: "main",
        setupScript: "true",
        resume: true,
        resumedFromSessionId: "prev",
        cliResumeRef: "cli-1",
        metadata: { k: 1 },
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();
      expect(profileSpawns).toBe(1);
      const status = serverMsgs.find((m) => m.type === "session:status");
      expect(status?.type === "session:status" && status.status).toBe("failed");
      // non-Error throw path from process runner
      const transport2 = createLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const loop2 = new AgentLoop({
        config,
        transport: transport2,
        processRunner: {
          async run(opts) {
            if (opts.argv[0] === "printf") {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- coverage: non-Error throw
              throw "string-fail";
            }
            return real.run(opts);
          },
        },
      });
      await loop2.start();
      transport2.deliver({
        type: "session:assign",
        sessionId: "sess-str",
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "echo-prompt",
        timeout: 10,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await loop2.waitForIdle();
      loop2.stop();
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
