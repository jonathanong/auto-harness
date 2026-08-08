/**
 * Phase 3 local e2e: ControlPlane create → assign → AgentLoop ack/run → terminal.
 * Uses in-process loopback (local parity for API GW WS), not a reimplementation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlPlane } from "../services/api/src/control-plane.ts";
import { AgentLoop, createLoopbackTransport } from "../services/agent/src/agent-loop.ts";
import type { AgentConfig } from "../services/agent/src/config.ts";
import { runCommandOk } from "./lib/run-command.mts";

async function git(cwd: string, args: string[]): Promise<string> {
  return runCommandOk("git", args, { cwd });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ah-p3-e2e-"));
  try {
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README"), "phase3\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);
    await git(repo, ["checkout", "-b", "feature/p3"]);
    writeFileSync(join(repo, "feat.txt"), "x\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feat"]);
    const featureSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["checkout", "main"]);

    const hookOut = join(root, "hook.out");
    const hook = join(root, "hook.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf '%s\\n' "$HARNESS_SESSION_ID" "$HARNESS_STATUS" "$HARNESS_REF" "$HARNESS_WORKTREE_PATH" > "${hookOut}"\n`,
      { mode: 0o755 },
    );

    const config: AgentConfig = {
      hostId: "agent-p3",
      logLevel: "info",
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

    let plane!: ControlPlane;
    const transport = createLoopbackTransport({
      sendToServer: (msg) => {
        plane.handleAgentMessage(msg);
      },
    });

    plane = new ControlPlane({
      publicBaseUrl: "http://ui",
      idFactory: (() => {
        let n = 0;
        return () => `sess-p3-${++n}`;
      })(),
      shardCount: 1,
      onAgentMessage: (_hostId, msg) => {
        transport.deliver(msg);
      },
    });

    const loop = new AgentLoop({ config, transport });
    await loop.start();

    plane.createCommand({
      id: "cmd-echo",
      name: "echo-prompt",
      argv: ["printf", "%s"],
      appendPrompt: true,
      providerId: null,
    });
    const created = plane.createSession({
      repositoryId: "demo",
      prompt: "hello-p3",
      commandId: "cmd-echo",
      timeout: 60,
      ref: "feature/p3",
      requiredLabels: ["echo"],
      metadata: { source: "phase3-e2e" },
    });
    if (!created.ok) {
      throw new Error(created.error);
    }

    plane.assignQueued();
    await loop.waitForIdle();

    const session = plane.getSession(created.session.id);
    if (!session || session.status !== "completed") {
      throw new Error(`expected completed, got ${JSON.stringify(session)}`);
    }
    if (!session.url.includes(created.session.id)) {
      throw new Error("missing url");
    }

    const logs = plane.getLogs(created.session.id);
    if (logs.length === 0) {
      throw new Error("expected logs");
    }

    // Terminal hook env (D3) — must fire with session id, status, ref
    const hookBody = readFileSync(hookOut, "utf8");
    const hookLines = hookBody.trim().split("\n");
    if (hookLines[0] !== created.session.id) {
      throw new Error(`hook session id missing: ${hookBody}`);
    }
    if (hookLines[1] !== "completed") {
      throw new Error(`hook status missing: ${hookBody}`);
    }
    if (hookLines[2] !== "feature/p3") {
      throw new Error(`hook ref missing: ${hookBody}`);
    }
    if (!hookLines[3]?.includes("wt-1")) {
      throw new Error(`hook worktree path missing: ${hookBody}`);
    }

    // HEAD on worktree matches feature ref
    const head = (await git(wt, ["rev-parse", "HEAD"])).trim();
    if (head !== featureSha) {
      throw new Error(`worktree HEAD ${head} != feature ${featureSha}`);
    }

    // Unknown command rejected at create time (existence check), not spawn time.
    const bad = plane.createSession({
      repositoryId: "demo",
      prompt: "x",
      commandId: "not-a-command",
      timeout: 30,
      requiredLabels: ["echo"],
    });
    if (bad.ok) {
      throw new Error("create should reject a commandId that doesn't exist");
    }

    // Terminal hook failure must not flip a real command failure's reported status (D3).
    writeFileSync(hook, `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
    plane.createCommand({
      id: "cmd-fail",
      name: "always-fail",
      argv: ["false"],
      appendPrompt: false,
      providerId: null,
    });
    const failing = plane.createSession({
      repositoryId: "demo",
      prompt: "x",
      commandId: "cmd-fail",
      timeout: 30,
      requiredLabels: ["echo"],
    });
    if (!failing.ok) {
      throw new Error(failing.error);
    }
    plane.assignQueued();
    await loop.waitForIdle();
    const failedSess = plane.getSession(failing.session.id);
    if (failedSess?.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(failedSess)}`);
    }
    loop.stop();

    console.log(
      JSON.stringify({
        ok: true,
        sessionId: session.id,
        status: session.status,
        url: session.url,
        ref: session.ref,
        featureSha,
        head,
        logCount: logs.length,
        unknownProfileRejected: true,
        hookEnv: {
          sessionId: hookLines[0],
          status: hookLines[1],
          ref: hookLines[2],
          worktreePath: hookLines[3],
        },
        hookFailureDoesNotFlipStatus: true,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
