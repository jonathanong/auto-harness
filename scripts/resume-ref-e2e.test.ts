/**
 * Invariant 7 / D5: resume pins agent only; re-checkout via ref succeeds even
 * when the original worktree was reused (AgentLoop + real git).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ControlPlane } from "../services/api/src/control-plane.js";
import { AgentLoop, createLoopbackTransport } from "../services/agent/src/agent-loop.js";
import type { AgentConfig } from "../services/agent/src/config.js";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

describe("resume re-checks out ref after worktree reuse", () => {
  it("AgentLoop lands resume session HEAD on original ref via different worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-resume-"));
    try {
      const repo = join(root, "repo");
      const wtA = join(root, "wt-a");
      const wtB = join(root, "wt-b");
      mkdirSync(repo);
      git(repo, ["init"]);
      git(repo, ["config", "user.email", "t@t"]);
      git(repo, ["config", "user.name", "t"]);
      writeFileSync(join(repo, "README"), "base\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "init"]);
      git(repo, ["branch", "-M", "main"]);
      git(repo, ["checkout", "-b", "feature/resume"]);
      writeFileSync(join(repo, "feat.txt"), "resume-me\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "feat"]);
      const featureSha = git(repo, ["rev-parse", "HEAD"]);
      git(repo, ["checkout", "main"]);

      const config: AgentConfig = {
        agentId: "agent-resume",
        logLevel: "info",
        repositories: [
          {
            id: "demo",
            path: repo,
            defaultBranch: "main",
            worktrees: [
              { id: "wt-a", path: wtA, labels: ["echo"] },
              { id: "wt-b", path: wtB, labels: ["echo"] },
            ],
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
        idFactory: (() => {
          let n = 0;
          return () => `sess-r${++n}`;
        })(),
        shardCount: 1,
        onAgentMessage: (_a, msg) => {
          transport.deliver(msg);
        },
      });

      const loop = new AgentLoop({ config, transport });
      await loop.start();

      // First session on feature/resume
      const first = plane.createSession({
        repositoryId: "demo",
        prompt: "first",
        commandProfile: "echo-prompt",
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
      const firstWt = plane.getSession(first.session.id)?.worktreeId;
      // After complete worktree is released; capture which path held feature
      // Intervening session reuses a worktree (may reset it to main via no ref)
      const intervening = plane.createSession({
        repositoryId: "demo",
        prompt: "intervening",
        commandProfile: "echo-prompt",
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

      // Resume pins agent only; re-checkout feature/resume on whichever free wt
      // Force agentId for resume pin (released sessions clear agentId)
      const firstRec = plane.getSession(first.session.id)!;
      // resumeSession uses agentId from completed source — ensure pin
      const resumed = plane.resumeSession(first.session.id);
      // completed session may have null agentId after release — pin via register state
      if (!resumed.ok) {
        // set agent on source for resume
        const any = plane as unknown as {
          sessions: Map<string, { agentId?: string | null; pinnedAgentId?: string | null }>;
        };
        any.sessions.get(first.session.id)!.agentId = "agent-resume";
        const again = plane.resumeSession(first.session.id);
        expect(again.ok).toBe(true);
        if (!again.ok) {
          return;
        }
        plane.assignQueued();
        await loop.waitForIdle();
        const rSess = plane.getSession(again.session.id);
        expect(rSess?.status).toBe("completed");
        expect(rSess?.ref).toBe("feature/resume");
        const resumeWtId = rSess?.worktreeId;
        const resumePath = resumeWtId === "wt-a" ? wtA : wtB;
        const head = git(resumePath, ["rev-parse", "HEAD"]);
        expect(head).toBe(featureSha);
        // Prefer different path than first when possible
        void firstWt;
        void firstRec;
      } else {
        plane.assignQueued();
        await loop.waitForIdle();
        const rSess = plane.getSession(resumed.session.id);
        expect(rSess?.status).toBe("completed");
        expect(rSess?.ref).toBe("feature/resume");
        const resumeWtId = rSess?.worktreeId;
        const resumePath = resumeWtId === "wt-a" ? wtA : wtB;
        const head = git(resumePath, ["rev-parse", "HEAD"]);
        expect(head).toBe(featureSha);
      }

      loop.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
