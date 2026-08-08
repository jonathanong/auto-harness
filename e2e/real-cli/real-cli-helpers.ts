import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { fetchAgentHostConfig } from "../../services/agent/src/bootstrap.ts";
import { startAgentDaemon } from "../../services/agent/src/start-daemon.ts";
import { runCommandOk } from "../../scripts/lib/run-command.mts";

const API = "http://127.0.0.1:7430";

const REAL_CLI_PROMPT =
  "Reply with exactly: hello world. Do not use any tools. Do not read, create, or modify any files.";

/** `spawnSync("which", ...)` presence check — used for `test.skip()`, not an async describe-time check. */
export function hasCli(bin: string): boolean {
  return spawnSync("which", [bin]).status === 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

/**
 * Full real-CLI orchestration flow, shared by claude-print.spec.ts and codex-exec.spec.ts:
 * real temp git repo, real in-process agent daemon (real WS, real subprocess), real
 * browser-driven session creation against a real Provider/Command/ProviderAccount, poll to
 * completion, assert the real CLI's stdout. Mirrors e2e/control/orchestration.spec.ts's
 * shape, but with a real AI CLI instead of `echo` and a case-insensitive substring match
 * (model output varies) instead of an exact line match.
 */
export async function runRealCliSession(opts: {
  page: Page;
  request: APIRequestContext;
  providerName: string;
  argv: string[];
  appendPrompt: boolean;
  expectStdout: RegExp;
}): Promise<void> {
  const { page, request, providerName, argv, appendPrompt, expectStdout } = opts;
  const agentId = `pw-real-${providerName}-${Date.now()}`;
  const repoId = `pw-real-repo-${providerName}-${Date.now()}`;
  const wtId = `wt-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), `pw-real-cli-${providerName}-`));
  const repo = join(root, "repo");
  const wt = join(root, wtId);
  let stopAgent: (() => Promise<void>) | undefined;

  try {
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "pw@pw"]);
    await git(repo, ["config", "user.name", "pw"]);
    writeFileSync(join(repo, "README"), `${providerName}\n`);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);

    const providerRes = await request.post(`${API}/api/v1/providers`, {
      data: { name: providerName },
    });
    expect(providerRes.ok(), `create provider failed: ${await providerRes.text()}`).toBeTruthy();
    const provider = await providerRes.json();

    const commandRes = await request.post(`${API}/api/v1/commands`, {
      data: { name: `${providerName}-print`, argv, appendPrompt, providerId: provider.id },
    });
    expect(commandRes.ok(), `create command failed: ${await commandRes.text()}`).toBeTruthy();
    const command = await commandRes.json();

    const patchRes = await request.patch(`${API}/api/v1/providers/${provider.id}`, {
      data: { defaultCommandId: command.id },
    });
    expect(patchRes.ok(), `set default command failed: ${await patchRes.text()}`).toBeTruthy();

    const accountRes = await request.post(`${API}/api/v1/provider-accounts`, {
      data: { providerId: provider.id, label: "e2e" },
    });
    expect(
      accountRes.ok(),
      `create provider account failed: ${await accountRes.text()}`,
    ).toBeTruthy();
    const account = await accountRes.json();

    const configRes = await request.put(`${API}/api/v1/agents/${agentId}/config`, {
      data: {
        repositories: [
          {
            id: repoId,
            path: repo,
            defaultBranch: "main",
            worktrees: [{ id: wtId, name: wtId, path: wt, labels: [providerName] }],
          },
        ],
        providerAccounts: [{ providerAccountId: account.id }],
        commandProfiles: {},
      },
    });
    expect(configRes.ok(), `attach account to host failed: ${await configRes.text()}`).toBeTruthy();

    // Real bootstrap fetch (GET /api/v1/agents/:id/config), same as `pnpm local:agent start`.
    const config = await fetchAgentHostConfig({
      agentId,
      apiUrl: "ws://127.0.0.1:7430/ws",
      logLevel: "info",
    });
    const daemon = await startAgentDaemon({
      config,
      log: () => undefined,
      error: () => undefined,
    });
    stopAgent = daemon.stop;
    await new Promise((r) => setTimeout(r, 200));

    await page.goto("/sessions/new");
    await expect(page.getByTestId("create-session-target")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("create-session-repository-id").fill(repoId);
    await page
      .getByTestId("create-session-target")
      .selectOption({ label: `${providerName} — e2e` });
    await page.getByTestId("create-session-prompt").fill(REAL_CLI_PROMPT);
    await page.getByTestId("create-session-timeout").fill("240");
    await page.getByTestId("create-session-submit").click();

    await expect(page.getByTestId("page-session-detail")).toBeVisible({ timeout: 15_000 });
    const sessionId = await page.getByTestId("session-detail-id").innerText();

    // Local dev/test never auto-assigns — nudge the scheduler, same as every other real-daemon
    // spec here. Real CLI turns take real wall-clock time, so poll far longer than the echo case.
    let status = "queued";
    for (let i = 0; i < 240 && status !== "completed" && status !== "failed"; i++) {
      await request.post(`${API}/api/v1/scheduler/assign`);
      await new Promise((r) => setTimeout(r, 1_000));
      const res = await request.get(`${API}/api/v1/sessions/${sessionId}`);
      status = ((await res.json()) as { status: string }).status;
    }
    expect(status).toBe("completed");

    await page.reload();
    await expect(page.getByTestId("session-detail-status")).toContainText("completed");

    const logsRes = await request.get(`${API}/api/v1/sessions/${sessionId}/logs`);
    const { items } = (await logsRes.json()) as {
      items: Array<{ stream: string; content: string }>;
    };
    const stdout = items
      .filter((l) => l.stream === "stdout")
      .map((l) => l.content)
      .join("\n");
    expect(stdout).toMatch(expectStdout);
  } finally {
    await stopAgent?.();
    rmSync(root, { recursive: true, force: true });
  }
}
