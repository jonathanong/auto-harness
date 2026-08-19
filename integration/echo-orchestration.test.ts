import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DaemonConfig } from "../services/host-daemon/src/config.ts";
import { startDaemon } from "../services/host-daemon/src/start-daemon.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import type { LogRecord } from "../services/api/src/control-plane-types.ts";
import { runCommandOk } from "../scripts/lib/run-command.mts";

/**
 * The only test in the repo that runs the full real orchestration path end to
 * end: a real HTTP+WS server, a real agent daemon connected over a real
 * `ws://` socket, and a real `echo` subprocess in a real git worktree — as
 * opposed to e2e/*.spec.ts, which fake out the agent side over REST since
 * Playwright never starts a daemon. See docs/host-daemon-e2e-testing.md.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopDaemon?.();
  await closeServer?.();
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
  root = undefined;
  stopDaemon = undefined;
  closeServer = undefined;
});

describe("real orchestration: create -> assign -> run -> completed", () => {
  it("runs `echo hello world` in a real agent daemon and captures real stdout", async () => {
    root = mkdtempSync(join(tmpdir(), "ah-echo-orchestration-"));
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README"), "echo\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);

    const port = 19000 + Math.floor(Math.random() * 2000);
    const server = await startLocalServer({
      port,
      useDynamo: false,
      enableWs: true,
      publicBaseUrl: "http://ui",
    });
    closeServer = server.close;
    server.plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "agent-echo",
      repositoryId: "demo",
      path: wt,
      labels: ["echo"],
      status: "idle",
      online: true,
    });

    const config: DaemonConfig = {
      hostId: "agent-echo",
      logLevel: "info",
      apiUrl: `ws://127.0.0.1:${port}/ws`,
      repositories: [
        {
          id: "demo",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: wt, labels: ["echo"] }],
        },
      ],
      providerAccounts: [],
      commandProfiles: {},
    };

    const daemon = await startDaemon({ config, log: () => undefined, error: () => undefined });
    stopDaemon = daemon.stop;
    await sleep(100);

    const commandResult = server.plane.createCommand({
      name: "echo-prompt",
      argv: ["echo", "hello world"],
      appendPrompt: false,
      providerId: null,
    });
    if (!commandResult.ok) {
      throw new Error(commandResult.error);
    }

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "demo",
        prompt: "unused",
        target: { commandId: commandResult.command.id },
        timeout: 60,
        requiredLabels: ["echo"],
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    server.plane.assignQueued();

    let session = server.plane.getSession(id);
    for (let i = 0; i < 100; i++) {
      session = server.plane.getSession(id);
      if (session?.status === "completed" || session?.status === "failed") {
        break;
      }
      await sleep(100);
      if (session?.status === "queued") {
        server.plane.assignQueued();
      }
    }
    expect(session?.status).toBe("completed");

    // Real HTTP round trip, not just the in-process plane accessor.
    const logsRes = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${id}/logs`);
    expect(logsRes.status).toBe(200);
    const { items } = (await logsRes.json()) as { items: LogRecord[] };
    expect(items.some((l) => l.stream === "stdout" && l.content.includes("hello world"))).toBe(
      true,
    );
  });
});
