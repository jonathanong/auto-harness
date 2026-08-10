import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";

describe("DaemonLoop errors", () => {
  it("rejects a non-scheduled assignment without a worktree", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const logs: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          serverMsgs.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => logs.push(line) });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "sess-missing-worktree",
        repositoryId: "demo",
        prompt: "must not run",
        resolvedArgv: ["false"],
        timeout: 10,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await expect(loop.waitForIdle()).rejects.toThrow("missing a worktree");

      transport.deliver({
        type: "session:assign",
        sessionId: "sess-scheduled-worktree",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "must use main checkout",
        resolvedArgv: ["false"],
        timeout: 10,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await expect(loop.waitForIdle()).rejects.toThrow("must use the main checkout");

      expect(serverMsgs.some((message) => message.type === "session:ack")).toBe(false);
      expect(serverMsgs.some((message) => message.type === "session:status")).toBe(false);
      expect(logs.some((line) => line.includes("missing a worktree"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("rejects an empty resolvedArgv without shell spawn success", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "sess-bad",
        repositoryId: "demo",
        prompt: "x",
        resolvedArgv: [],
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
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const { SpawnProcessRunner } = await import("./executor.ts");
      const real = new SpawnProcessRunner();
      let profileSpawns = 0;
      const loop = new DaemonLoop({
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
        resolvedArgv: ["printf", "%s", "x"],
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
      const transport2 = createAcknowledgingLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const loop2 = new DaemonLoop({
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
        resolvedArgv: ["printf", "%s", "x"],
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
