import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseAgentConfig, type AgentConfig } from "../../services/agent/src/config.ts";
import { git, revParse } from "./git.mts";

export type LocalE2ePaths = {
  root: string;
  repoPath: string;
  wtPath: string;
  hookPath: string;
  hookLog: string;
};

export function buildPaths(root: string): LocalE2ePaths {
  return {
    root,
    repoPath: join(root, "repo"),
    wtPath: join(root, "wt-1"),
    hookPath: join(root, "hook.sh"),
    hookLog: join(root, "hook.log"),
  };
}

/** Init temp git repo with main + feature/local-e2e; return feature SHA. */
export async function initFeatureRepo(paths: LocalE2ePaths): Promise<string> {
  const { repoPath, hookPath, hookLog } = paths;
  mkdirSync(repoPath);
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "e2e@example.com"]);
  await git(repoPath, ["config", "user.name", "e2e"]);
  writeFileSync(join(repoPath, "README.md"), "main\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "main"]);
  // default branch name may be master on some git — rename to main
  await git(repoPath, ["branch", "-M", "main"]);
  await git(repoPath, ["checkout", "-b", "feature/local-e2e"]);
  writeFileSync(join(repoPath, "feature.txt"), "on-feature\n");
  await git(repoPath, ["add", "feature.txt"]);
  await git(repoPath, ["commit", "-m", "feature"]);
  const featureSha = await revParse(repoPath, "HEAD");
  await git(repoPath, ["checkout", "main"]);

  writeFileSync(
    hookPath,
    `#!/bin/sh\necho "$HARNESS_SESSION_ID $HARNESS_STATUS $HARNESS_WORKTREE_PATH" > "${hookLog}"\n`,
    { mode: 0o755 },
  );

  return featureSha;
}

export function buildAgentConfig(paths: LocalE2ePaths): AgentConfig {
  return parseAgentConfig({
    agentId: "local-e2e",
    commandProfiles: {
      "echo-prompt": { argv: ["echo"], appendPrompt: true },
      "nope-profile": { argv: ["false"], appendPrompt: false },
    },
    repositories: [
      {
        id: "demo",
        path: paths.repoPath,
        defaultBranch: "main",
        terminalHookScript: paths.hookPath,
        worktrees: [
          {
            id: "wt-1",
            name: "wt-1",
            path: paths.wtPath,
            labels: ["echo"],
          },
        ],
      },
    ],
  });
}
