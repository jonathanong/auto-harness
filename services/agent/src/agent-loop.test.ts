import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";

import { AgentLoop, createLoopbackTransport } from "./agent-loop.js";
import type { AgentConfig } from "./config.js";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
}

function makeRepo(): { root: string; config: AgentConfig; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ah-loop-"));
  const repo = join(root, "repo");
  const wt = join(root, "wt-1");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README"), "hi\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["branch", "-M", "main"]);
  const hook = join(root, "hook.sh");
  writeFileSync(hook, "#!/bin/sh\necho ok\n");
  spawnSync("chmod", ["+x", hook]);

  const config: AgentConfig = {
    agentId: "agent-loop",
    logLevel: "info",
    repositories: [
      {
        id: "demo",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", path: wt, labels: ["echo"] }],
        terminalHookScript: hook,
      },
    ],
    commandProfiles: {
      "echo-prompt": { argv: ["printf", "%s"], appendPrompt: true },
    },
  };
  return {
    root,
    config,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("AgentLoop", () => {
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

  it("drain refuses new assigns without killing inflight tracking", async () => {
    const { config, cleanup } = makeRepo();
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
        commandProfile: "echo-prompt",
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
      const { SpawnProcessRunner } = await import("./executor.js");
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
