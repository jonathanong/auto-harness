import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { DaemonConfig } from "./config.ts";
import type { HostToServerMessage } from "@auto-harness/shared";
import { createLoopbackTransport } from "./loopback-transport.ts";

/** Test-only in-process peer that confirms an ACK only after its mock server
 * handler completes. Tests that need an ambiguous write must use the raw
 * loopback transport and deliver the confirmation themselves. */
export function createAcknowledgingLoopbackTransport(opts: {
  sendToServer: (msg: HostToServerMessage) => void | Promise<void>;
}) {
  const transport = createLoopbackTransport({
    sendToServer: async (message) => {
      await opts.sendToServer(message);
      if (message.type === "session:ack") {
        transport.deliver({ type: "session:acknowledged", sessionId: message.sessionId });
      }
    },
  });
  return transport;
}

async function runOk(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`${command} ${args.join(" ")}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function git(cwd: string, args: string[]): Promise<void> {
  await runOk("git", args, cwd);
}

export async function makeRepo(): Promise<{
  root: string;
  config: DaemonConfig;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "ah-loop-"));
  const repo = join(root, "repo");
  const wt = join(root, "wt-1");
  mkdirSync(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README"), "hi\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  await git(repo, ["branch", "-M", "main"]);
  const hook = join(root, "hook.sh");
  writeFileSync(hook, "#!/bin/sh\necho ok\n", { mode: 0o755 });

  const config: DaemonConfig = {
    hostId: "agent-loop",
    repositories: [
      {
        id: "demo",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: wt, labels: ["echo"] }],
        terminalHookScript: hook,
      },
    ],
    providerAccounts: [],
  };
  return {
    root,
    config,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
