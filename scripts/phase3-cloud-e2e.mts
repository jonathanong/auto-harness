/**
 * Phase 3 local e2e: ControlPlane create → assign → AgentLoop ack/run → terminal.
 * Uses in-process loopback (local parity for API GW WS), not a reimplementation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ControlPlane } from "../services/api/src/control-plane.ts";
import { AgentLoop, createLoopbackTransport } from "../services/agent/src/agent-loop.ts";
import type { AgentConfig } from "../services/agent/src/config.ts";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ah-p3-e2e-"));
  try {
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README"), "phase3\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["checkout", "-b", "feature/p3"]);
    writeFileSync(join(repo, "feat.txt"), "x\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feat"]);
    const featureSha = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "main"]);

    const hookOut = join(root, "hook.out");
    const hook = join(root, "hook.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf '%s\\n' "$HARNESS_SESSION_ID" "$HARNESS_STATUS" "$HARNESS_REF" "$HARNESS_WORKTREE_PATH" > "${hookOut}"\n`,
    );
    spawnSync("chmod", ["+x", hook]);

    const config: AgentConfig = {
      agentId: "agent-p3",
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
      onAgentMessage: (_agentId, msg) => {
        transport.deliver(msg);
      },
    });

    const loop = new AgentLoop({ config, transport });
    await loop.start();

    const created = plane.createSession({
      repositoryId: "demo",
      prompt: "hello-p3",
      commandProfile: "echo-prompt",
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
    const head = git(wt, ["rev-parse", "HEAD"]).trim();
    if (head !== featureSha) {
      throw new Error(`worktree HEAD ${head} != feature ${featureSha}`);
    }

    // Unknown profile rejected by agent (Invariant 8 / D4); hook failure must not flip status
    writeFileSync(hook, `#!/bin/sh\nexit 1\n`);
    spawnSync("chmod", ["+x", hook]);
    const bad = plane.createSession({
      repositoryId: "demo",
      prompt: "x",
      commandProfile: "not-a-profile",
      timeout: 30,
      requiredLabels: ["echo"],
    });
    if (!bad.ok) {
      throw new Error("create should accept profile name string (agent rejects unknown)");
    }
    plane.assignQueued();
    await loop.waitForIdle();
    const badSess = plane.getSession(bad.session.id);
    if (badSess?.status !== "failed" || badSess.errorCode !== "unknown_command_profile") {
      throw new Error(`expected unknown_command_profile, got ${JSON.stringify(badSess)}`);
    }
    // status remains failed despite hook exit 1
    if (plane.getSession(bad.session.id)?.status !== "failed") {
      throw new Error("hook failure altered session status");
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
