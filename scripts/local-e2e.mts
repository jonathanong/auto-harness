/**
 * Phase 1 local end-to-end path (no AWS):
 * 1) temp git repo + feature branch
 * 2) agent config with echo-prompt profile
 * 3) optional local API create
 * 4) SessionRunner run with ref checkout
 *
 * Exit 0 only if session completes and HEAD matches the session ref.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseAgentConfig } from "../services/agent/src/config.js";
import { SpawnProcessRunner } from "../services/agent/src/executor.js";
import { createGitClient } from "../services/agent/src/git.js";
import { SessionRunner } from "../services/agent/src/session-runner.js";
import { WorktreeManager } from "../services/agent/src/worktree-manager.js";
import { createLocalApp } from "../services/api/src/local-server.js";
import { MemorySessionStore } from "../services/api/src/memory-store.js";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
}

function revParse(cwd: string, rev: string): string {
  const r = spawnSync("git", ["rev-parse", rev], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`rev-parse failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ah-local-e2e-"));
  const repoPath = join(root, "repo");
  const wtPath = join(root, "wt-1");
  const hookPath = join(root, "hook.sh");
  const hookLog = join(root, "hook.log");

  try {
    mkdirSync(repoPath);
    git(repoPath, ["init"]);
    git(repoPath, ["config", "user.email", "e2e@example.com"]);
    git(repoPath, ["config", "user.name", "e2e"]);
    writeFileSync(join(repoPath, "README.md"), "main\n");
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "main"]);
    // default branch name may be master on some git — rename to main
    git(repoPath, ["branch", "-M", "main"]);
    git(repoPath, ["checkout", "-b", "feature/local-e2e"]);
    writeFileSync(join(repoPath, "feature.txt"), "on-feature\n");
    git(repoPath, ["add", "feature.txt"]);
    git(repoPath, ["commit", "-m", "feature"]);
    const featureSha = revParse(repoPath, "HEAD");
    git(repoPath, ["checkout", "main"]);

    writeFileSync(
      hookPath,
      `#!/bin/sh\necho "$HARNESS_SESSION_ID $HARNESS_STATUS $HARNESS_WORKTREE_PATH" > "${hookLog}"\n`,
      { mode: 0o755 },
    );

    const config = parseAgentConfig({
      agentId: "local-e2e",
      commandProfiles: {
        "echo-prompt": { argv: ["echo"], appendPrompt: true },
        "nope-profile": { argv: ["false"], appendPrompt: false },
      },
      repositories: [
        {
          id: "demo",
          path: repoPath,
          defaultBranch: "main",
          terminalHookScript: hookPath,
          worktrees: [
            {
              id: "wt-1",
              path: wtPath,
              labels: ["echo"],
            },
          ],
        },
      ],
    });

    // --- API create (documented local path) ---
    const store = new MemorySessionStore({
      publicBaseUrl: "http://localhost:3000",
      idFactory: () => "sess-e2e",
      now: () => new Date().toISOString(),
    });
    const { handler } = createLocalApp({ store });
    // Drive handler without listening (same code path as HTTP)
    const body = {
      repositoryId: "demo",
      prompt: "hello-from-e2e",
      commandProfile: "echo-prompt",
      timeout: 30,
      ref: "feature/local-e2e",
      requiredLabels: ["echo"],
    };
    let createStatus = 0;
    let createJson = "";
    const req = {
      method: "POST",
      url: "/api/v1/sessions",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "data") {
          cb(Buffer.from(JSON.stringify(body)));
        }
        if (event === "end") {
          cb();
        }
        return req;
      },
    };
    const res = {
      writeHead(code: number) {
        createStatus = code;
      },
      end(payload: string) {
        createJson = payload;
      },
    };
    await handler(req as never, res as never);
    if (createStatus !== 201) {
      throw new Error(`API create failed: ${createStatus} ${createJson}`);
    }
    const created = JSON.parse(createJson) as {
      id: string;
      status: string;
      url: string;
      commandProfile: string;
      ref?: string;
    };
    if (created.status !== "queued" || !created.url.includes(created.id)) {
      throw new Error(`unexpected create body: ${createJson}`);
    }

    // Unknown profile fails without shell
    {
      const runner = new SpawnProcessRunner();
      const gitClient = createGitClient(runner);
      const worktrees = new WorktreeManager(config, gitClient);
      await worktrees.ensureAll();
      const sessionRunner = new SessionRunner({
        config,
        worktrees,
        processRunner: runner,
      });
      const bad = await sessionRunner.run({
        sessionId: "sess-bad-profile",
        repositoryId: "demo",
        prompt: "x",
        commandProfile: "does-not-exist",
        timeout: 30,
        worktreeId: "wt-1",
        ref: "feature/local-e2e",
      });
      if (bad.status !== "failed" || bad.errorCode !== "unknown_command_profile") {
        throw new Error(`expected unknown_command_profile, got ${JSON.stringify(bad)}`);
      }
    }

    // Happy path: run session on feature ref
    const processRunner = new SpawnProcessRunner();
    const gitClient = createGitClient(processRunner);
    const worktrees = new WorktreeManager(config, gitClient);
    await worktrees.ensureAll();
    const sessionRunner = new SessionRunner({
      config,
      worktrees,
      processRunner,
    });
    const result = await sessionRunner.run({
      sessionId: created.id,
      repositoryId: "demo",
      prompt: body.prompt,
      commandProfile: body.commandProfile,
      timeout: body.timeout,
      worktreeId: "wt-1",
      ref: "feature/local-e2e",
    });

    if (result.status !== "completed") {
      throw new Error(`session did not complete: ${JSON.stringify(result)}`);
    }

    const head = revParse(wtPath, "HEAD");
    if (head !== featureSha) {
      throw new Error(`worktree HEAD ${head} != feature sha ${featureSha} (ref checkout failed)`);
    }

    // hook ran for completed
    const hookOut = spawnSync("cat", [hookLog], { encoding: "utf8" });
    if (!hookOut.stdout.includes(created.id) || !hookOut.stdout.includes("completed")) {
      throw new Error(`terminal hook missing env: ${hookOut.stdout}`);
    }

    // monotonic seq
    const seqs = result.logs.map((l) => l.seq);
    for (let i = 1; i < seqs.length; i++) {
      if ((seqs[i] ?? 0) <= (seqs[i - 1] ?? 0)) {
        throw new Error(`log seq not monotonic: ${seqs.join(",")}`);
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId: created.id,
          status: result.status,
          head,
          featureSha,
          logCount: result.logs.length,
          hook: hookOut.stdout.trim(),
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
