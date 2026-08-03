import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { AgentConfig } from "./config.ts";

export function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
}

export function makeRepo(): { root: string; config: AgentConfig; cleanup: () => void } {
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
