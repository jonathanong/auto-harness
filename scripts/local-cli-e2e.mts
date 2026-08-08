/**
 * Documented CLI path:
 *   ephemeral local API + PUT host inventory +
 *   HARNESS_* env + pnpm local:agent run-session --file …
 *
 * Uses async spawn so the in-process API event loop can serve bootstrap GETs.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLocalServer } from "../services/api/src/local-server.ts";
import { runCommand, runCommandOk } from "./lib/run-command.mts";

async function git(cwd: string, args: string[]): Promise<string> {
  return runCommandOk("git", args, { cwd });
}

function runAgent(args: string[], env: NodeJS.ProcessEnv) {
  return runCommand("pnpm", ["local:agent", ...args], { cwd: process.cwd(), env });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ah-cli-e2e-"));
  const port = 19000 + Math.floor(Math.random() * 2000);
  const api = `http://127.0.0.1:${port}`;
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    server = await startLocalServer({
      port,
      useDynamo: false,
      enableWs: false,
      publicBaseUrl: "http://ui",
    });

    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "e2e@example.com"]);
    await git(repo, ["config", "user.name", "e2e"]);
    writeFileSync(join(repo, "README.md"), "main\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "main"]);
    await git(repo, ["branch", "-M", "main"]);
    const mainSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const hostId = "cli-e2e";
    const put = await fetch(`${api}/api/v1/agents/${encodeURIComponent(hostId)}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositories: [
          {
            id: "demo",
            path: repo,
            defaultBranch: "main",
            worktrees: [{ id: "wt-1", name: "wt-1", path: wt, labels: ["echo"] }],
          },
        ],
        commandProfiles: {
          "echo-prompt": { argv: ["echo"], appendPrompt: true },
        },
      }),
    });
    if (!put.ok) {
      throw new Error(`PUT host config ${put.status}: ${await put.text()}`);
    }

    const sessionPath = join(root, "session.assign.json");
    writeFileSync(
      sessionPath,
      JSON.stringify(
        {
          sessionId: "sess-cli-e2e",
          repositoryId: "demo",
          prompt: "hello-cli-e2e",
          resolvedArgv: ["echo", "hello-cli-e2e"],
          timeout: 60,
          worktreeId: "wt-1",
          ref: "main",
        },
        null,
        2,
      ),
    );

    const env = {
      ...process.env,
      HARNESS_AGENT_ID: hostId,
      HARNESS_API_URL: api,
    };

    const withSep = await runAgent(["--", "run-session", "--file", sessionPath], env);
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

    const head = (await git(wt, ["rev-parse", "HEAD"])).trim();
    if (head !== mainSha) {
      throw new Error(`worktree HEAD ${head} != main ${mainSha}`);
    }

    writeFileSync(
      sessionPath,
      JSON.stringify(
        {
          sessionId: "sess-cli-e2e-2",
          repositoryId: "demo",
          prompt: "again",
          resolvedArgv: ["echo", "again"],
          timeout: 60,
          worktreeId: "wt-1",
          ref: "main",
        },
        null,
        2,
      ),
    );
    const noSep = await runAgent(["run-session", "--file", sessionPath], env);
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
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
