/**
 * Documented CLI path (docs/setup.md):
 *   pnpm local:agent run-session --config … --file …
 * including ref: "main" while the primary tree is on main.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), "ah-cli-e2e-"));
  try {
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "e2e@example.com"]);
    git(repo, ["config", "user.name", "e2e"]);
    writeFileSync(join(repo, "README.md"), "main\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "main"]);
    git(repo, ["branch", "-M", "main"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    const configPath = join(root, "agent.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          agentId: "cli-e2e",
          commandProfiles: {
            "echo-prompt": { argv: ["echo"], appendPrompt: true },
          },
          repositories: [
            {
              id: "demo",
              path: repo,
              defaultBranch: "main",
              worktrees: [{ id: "wt-1", path: wt, labels: ["echo"] }],
            },
          ],
        },
        null,
        2,
      ),
    );

    const sessionPath = join(root, "session.assign.json");
    writeFileSync(
      sessionPath,
      JSON.stringify(
        {
          sessionId: "sess-cli-e2e",
          repositoryId: "demo",
          prompt: "hello-cli-e2e",
          commandProfile: "echo-prompt",
          timeout: 60,
          worktreeId: "wt-1",
          ref: "main",
        },
        null,
        2,
      ),
    );

    // Documented form with pnpm's `--` separator
    const withSep = spawnSync(
      "pnpm",
      ["local:agent", "--", "run-session", "--config", configPath, "--file", sessionPath],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );
    if (withSep.status !== 0) {
      throw new Error(
        `pnpm local:agent -- run-session failed:\n${withSep.stdout}\n${withSep.stderr}`,
      );
    }
    if (
      !withSep.stdout.includes('"status": "completed"') &&
      !withSep.stdout.includes('"status":"completed"')
    ) {
      throw new Error(`expected completed in stdout:\n${withSep.stdout}`);
    }

    const head = git(wt, ["rev-parse", "HEAD"]).trim();
    if (head !== mainSha) {
      throw new Error(`worktree HEAD ${head} != main ${mainSha}`);
    }

    // Also the form without `--`
    writeFileSync(
      sessionPath,
      JSON.stringify(
        {
          sessionId: "sess-cli-e2e-2",
          repositoryId: "demo",
          prompt: "again",
          commandProfile: "echo-prompt",
          timeout: 60,
          worktreeId: "wt-1",
          ref: "main",
        },
        null,
        2,
      ),
    );
    const noSep = spawnSync(
      "pnpm",
      ["local:agent", "run-session", "--config", configPath, "--file", sessionPath],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );
    if (noSep.status !== 0) {
      throw new Error(`pnpm local:agent run-session failed:\n${noSep.stdout}\n${noSep.stderr}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mainSha,
          head,
          withSepExit: withSep.status,
          noSepExit: noSep.status,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
