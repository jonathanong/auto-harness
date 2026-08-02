/**
 * Phase 3 local e2e: ControlPlane create → assign → AgentLoop ack/run → terminal.
 * Uses in-process loopback (local parity for API GW WS), not a reimplementation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    const hook = join(root, "hook.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\necho "$HARNESS_SESSION_ID $HARNESS_STATUS" > "${join(root, "hook.out")}"\n`,
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

    // Unknown profile rejected by agent (Invariant 8 / D4)
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
    loop.stop();

    console.log(
      JSON.stringify({
        ok: true,
        sessionId: session.id,
        status: session.status,
        url: session.url,
        ref: session.ref,
        featureSha,
        logCount: logs.length,
        unknownProfileRejected: true,
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
