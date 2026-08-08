/**
 * Invariant 7 / D5: resume pins agent only; re-checkout via ref succeeds even
 * when the original worktree was reused (AgentLoop + real git).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ControlPlane } from "../services/api/src/control-plane.ts";
import { AgentLoop, createLoopbackTransport } from "../services/agent/src/agent-loop.ts";
import type { AgentConfig } from "../services/agent/src/config.ts";
import { runCommandOk } from "./lib/run-command.mts";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

describe("resume re-checks out ref after worktree reuse", () => {
  it("AgentLoop lands resume session HEAD on original ref via different worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-resume-"));
    try {
      const repo = join(root, "repo");
      const wtA = join(root, "wt-a");
      const wtB = join(root, "wt-b");
      mkdirSync(repo);
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "t@t"]);
      await git(repo, ["config", "user.name", "t"]);
      writeFileSync(join(repo, "README"), "base\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "init"]);
      await git(repo, ["branch", "-M", "main"]);
      await git(repo, ["checkout", "-b", "feature/resume"]);
      writeFileSync(join(repo, "feat.txt"), "resume-me\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const featureSha = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["checkout", "main"]);

      const config: AgentConfig = {
        hostId: "agent-resume",
        logLevel: "info",
        repositories: [
          {
            id: "demo",
            path: repo,
            defaultBranch: "main",
            worktrees: [
              { id: "wt-a", name: "wt-a", path: wtA, labels: ["echo"] },
              { id: "wt-b", name: "wt-b", path: wtB, labels: ["echo"] },
            ],
          },
        ],
        providerAccounts: [],
        commandProfiles: {
          "echo-prompt": { argv: ["printf", "%s"], appendPrompt: true },
        },
      };

      let plane!: ControlPlane;
      const assigns: Array<{ sessionId: string; worktreeId: string | null; ref?: string }> = [];
      const transport = createLoopbackTransport({
        sendToServer: (msg) => {
          plane.handleAgentMessage(msg);
        },
      });
      plane = new ControlPlane({
        idFactory: (() => {
          let n = 0;
          return () => `sess-r${++n}`;
        })(),
        shardCount: 1,
        onAgentMessage: (_a, msg) => {
          if (msg.type === "session:assign") {
            assigns.push({
              sessionId: msg.sessionId,
              worktreeId: msg.worktreeId,
              ...(msg.ref !== undefined ? { ref: msg.ref } : {}),
            });
          }
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

      // First session on feature/resume
      const first = plane.createSession({
        repositoryId: "demo",
        prompt: "first",
        commandId: "cmd-echo",
        timeout: 60,
        ref: "feature/resume",
        requiredLabels: ["echo"],
      });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      plane.assignQueued();
      await loop.waitForIdle();
      expect(plane.getSession(first.session.id)?.status).toBe("completed");

      // Intervening session reuses a worktree and checks out main
      const intervening = plane.createSession({
        repositoryId: "demo",
        prompt: "intervening",
        commandId: "cmd-echo",
        timeout: 60,
        ref: "main",
        requiredLabels: ["echo"],
      });
      expect(intervening.ok).toBe(true);
      if (!intervening.ok) {
        return;
      }
      plane.assignQueued();
      await loop.waitForIdle();
      expect(plane.getSession(intervening.session.id)?.status).toBe("completed");

      // Ensure pin source has agent (complete keeps hostId)
      plane.state.sessions.get(first.session.id)!.hostId = "agent-resume";

      const resumed = plane.resumeSession(first.session.id);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) {
        return;
      }
      expect(resumed.session.ref).toBe("feature/resume");
      plane.assignQueued();
      await loop.waitForIdle();
      expect(plane.getSession(resumed.session.id)?.status).toBe("completed");

      const resumeAssign = assigns.find((a) => a.sessionId === resumed.session.id);
      expect(resumeAssign?.ref).toBe("feature/resume");
      expect(resumeAssign?.worktreeId).toBeTruthy();
      const resumePath = resumeAssign!.worktreeId === "wt-a" ? wtA : wtB;
      const head = await git(resumePath, ["rev-parse", "HEAD"]);
      expect(head).toBe(featureSha);

      loop.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
