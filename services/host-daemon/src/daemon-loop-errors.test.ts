/* eslint-disable max-lines -- daemon error coverage uses one shared lifecycle fixture. */
import { basename } from "node:path";
import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";
import { SpawnProcessRunner, type ProcessRunner } from "./executor.ts";

describe("DaemonLoop errors", () => {
  it("keeps Git credentials out of logs and the final session status", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const logs: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          serverMsgs.push(message);
        },
      });
      const fallback = new SpawnProcessRunner();
      const processRunner: ProcessRunner = {
        async run(options) {
          // git is now resolved to an absolute path before spawning; match by
          // basename, stripping a Windows executable extension (this real
          // spawn resolves to "git.exe" when actually run on Windows).
          const isGit =
            options.argv[0] !== undefined &&
            basename(options.argv[0]).replace(/\.(exe|cmd|bat|com)$/i, "") === "git";
          if (
            isGit &&
            options.argv[1] === "switch" &&
            options.argv[2] === "--" &&
            options.argv[3] === "main"
          ) {
            options.onChunk({
              stream: "stderr",
              data: "fatal: https://oauth:switch-secret@example.com/repo.git",
            });
            return { exitCode: 1, timedOut: false, signal: null };
          }
          if (isGit && options.argv[1] === "fetch") {
            options.onChunk({
              stream: "stderr",
              data: "fatal: https://oauth:fetch-secret@example.com/repo.git",
            });
            return { exitCode: 1, timedOut: false, signal: null };
          }
          return fallback.run(options);
        },
      };
      const loop = new DaemonLoop({
        config,
        transport,
        processRunner,
        onLog: (line) => logs.push(line),
      });
      await loop.start();

      transport.deliver({
        type: "session:assign",
        sessionId: "sess-main-switch",
        attemptId: "attempt-main-switch",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "switch main",
        resolvedArgv: ["true"],
        timeout: 10,
        worktreeId: null,
        ref: "main",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      transport.deliver({
        type: "session:assign",
        sessionId: "sess-main-fetch",
        attemptId: "attempt-main-fetch",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "fetch feature",
        resolvedArgv: ["true"],
        timeout: 10,
        worktreeId: null,
        ref: "feature",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      const statuses = serverMsgs.filter(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status",
      );
      expect(statuses).toHaveLength(2);
      expect(statuses[0]?.errorMessage).toContain("Failed to switch main checkout");
      expect(statuses[1]?.errorMessage).toContain("Failed to fetch branch feature");
      const output = JSON.stringify(serverMsgs) + logs.join("\n");
      expect(output).not.toContain("switch-secret");
      expect(output).not.toContain("fetch-secret");
      loop.stop();
    } finally {
      cleanup();
    }
  });

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
        attemptId: "attempt-sess-missing-worktree",
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
        attemptId: "attempt-sess-scheduled-worktree",
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
        attemptId: "attempt-sess-bad",
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

  it("maps optional assign fields and process failures to setup_failed", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const { SpawnProcessRunner: RealSpawnProcessRunner } = await import("./executor.ts");
      const real = new RealSpawnProcessRunner();
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
        attemptId: "attempt-sess-opt",
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
        attemptId: "attempt-sess-str",
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
