/**
 * Phase 3 e2e over real local WebSocket:
 * API /ws + agent startAgentDaemon → create → assign → completed + hook env.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLocalServer } from "../services/api/src/local-server.ts";
import { startAgentDaemon } from "../services/agent/src/start-daemon.ts";
import type { AgentConfig } from "../services/agent/src/config.ts";
import { runCommandOk } from "./lib/run-command.mts";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ah-ws-e2e-"));
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  let stopAgent: (() => Promise<void>) | undefined;
  try {
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README"), "ws\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);
    await git(repo, ["checkout", "-b", "feature/ws"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feat"]);
    const featureSha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "main"]);

    const hookOut = join(root, "hook.out");
    const hook = join(root, "hook.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf '%s\\n' "$HARNESS_SESSION_ID" "$HARNESS_STATUS" "$HARNESS_REF" > "${hookOut}"\n`,
      { mode: 0o755 },
    );

    const port = 18000 + Math.floor(Math.random() * 2000);
    server = await startLocalServer({
      port,
      useDynamo: false,
      enableWs: true,
      publicBaseUrl: "http://ui",
    });
    server.plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "agent-ws",
      repositoryId: "demo",
      path: wt,
      labels: ["echo"],
      status: "idle",
      online: true,
    });

    const config: AgentConfig = {
      hostId: "agent-ws",
      logLevel: "info",
      apiUrl: `ws://127.0.0.1:${port}/ws`,
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
      commandProfiles: {
        "echo-prompt": { argv: ["printf", "%s"], appendPrompt: true },
      },
    };

    const daemon = await startAgentDaemon({
      config,
      log: () => undefined,
      error: () => undefined,
    });
    stopAgent = daemon.stop;
    await sleep(100);

    const cmdRes = await fetch(`http://127.0.0.1:${port}/api/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "echo-prompt",
        argv: ["printf", "%s"],
        appendPrompt: true,
        providerId: null,
      }),
    });
    if (cmdRes.status !== 201) {
      throw new Error(`command create failed ${cmdRes.status} ${await cmdRes.text()}`);
    }
    const command = (await cmdRes.json()) as { id: string };

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "demo",
        prompt: "hello-ws",
        commandId: command.id,
        timeout: 60,
        ref: "feature/ws",
        requiredLabels: ["echo"],
      }),
    });
    if (created.status !== 201) {
      throw new Error(`create failed ${created.status} ${await created.text()}`);
    }
    const body = (await created.json()) as { id: string; url: string; ref?: string };
    if (!body.url || body.ref !== "feature/ws") {
      throw new Error(`bad create body ${JSON.stringify(body)}`);
    }

    // Assign over control plane (pushes session:assign on WS)
    server.plane.assignQueued();

    // Wait for terminal
    let session = server.plane.getSession(body.id);
    for (let i = 0; i < 50 && session?.status === "running"; i++) {
      await sleep(100);
      session = server.plane.getSession(body.id);
    }
    // also poll while queued→running→completed
    for (let i = 0; i < 50; i++) {
      session = server.plane.getSession(body.id);
      if (session?.status === "completed" || session?.status === "failed") {
        break;
      }
      await sleep(100);
      if (i === 0 || session?.status === "queued") {
        server.plane.assignQueued();
      }
    }

    session = server.plane.getSession(body.id);
    if (session?.status !== "completed") {
      throw new Error(`expected completed got ${JSON.stringify(session)}`);
    }

    const hookBody = readFileSync(hookOut, "utf8");
    const lines = hookBody.trim().split("\n");
    if (lines[0] !== body.id || lines[1] !== "completed" || lines[2] !== "feature/ws") {
      throw new Error(`hook env bad: ${hookBody}`);
    }
    const head = await git(wt, ["rev-parse", "HEAD"]);
    if (head !== featureSha) {
      throw new Error(`HEAD ${head} != ${featureSha}`);
    }

    console.log(
      JSON.stringify({
        ok: true,
        sessionId: body.id,
        status: session.status,
        url: body.url,
        ref: body.ref,
        featureSha,
        head,
        hookEnv: { sessionId: lines[0], status: lines[1], ref: lines[2] },
        transport: "websocket",
      }),
    );
  } finally {
    await stopAgent?.();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
