import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { fetchHostInventory } from "../../services/host-daemon/src/bootstrap.ts";
import { startDaemon } from "../../services/host-daemon/src/start-daemon.ts";
import { runCommandOk } from "../../scripts/lib/run-command.mts";
import { encodeSessionTargetOptionValue } from "../../services/web/src/session-target.ts";
import { API_BASE } from "../harness-endpoints.ts";

const API = API_BASE;

const REAL_CLI_PROMPT =
  "Reply with exactly: hello world. Do not use any tools. Do not read, create, or modify any files.";

/** `spawnSync("which", ...)` presence check — used for `test.skip()`, not an async describe-time check. */
export function hasCli(bin: string): boolean {
  return spawnSync("which", [bin]).status === 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

/** Shared singleton; retry CAS so parallel real-cli specs do not 409 each other. */
async function enableSessionLogUploadAlways(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const settingsRes = await request.get(`${API}/api/v1/session-log-settings`);
    expect(settingsRes.ok(), `session-log-settings get failed: ${await settingsRes.text()}`).toBe(
      true,
    );
    const settings = (await settingsRes.json()) as { version?: number; uploadMode?: string };
    if (settings.uploadMode === "always") return;
    const upload = await request.put(`${API}/api/v1/session-log-settings`, {
      data: {
        version: settings.version ?? 0,
        uploadMode: "always",
        batchMaxKb: 1,
        batchMaxLines: 1,
        batchMaxWaitMs: 1000,
      },
    });
    if (upload.ok()) return;
    if (upload.status() !== 409) {
      expect(upload.ok(), `session-log-settings upload always failed: ${await upload.text()}`).toBe(
        true,
      );
      return;
    }
  }
  throw new Error("session-log-settings upload always: version conflict retries exhausted");
}

/**
 * Full real-CLI orchestration flow, shared by claude/codex/grok specs:
 * real temp git repo, real in-process agent daemon (real WS, real subprocess), real
 * browser-driven session creation against a real Provider/Command/ProviderAccount, poll to
 * completion, assert the real CLI's stdout. Mirrors e2e/control/orchestration.spec.ts's
 * shape, but with a real AI CLI instead of `echo` and a case-insensitive substring match
 * (model output varies) instead of an exact line match.
 *
 * Provider-targeted sessions stay queued unless the daemon advertises that account ready
 * via `HARNESS_EXECUTION_PROFILES`. Transcript bodies only appear on GET /logs when upload
 * is on (default is off).
 */
export async function runRealCliSession(opts: {
  page: Page;
  request: APIRequestContext;
  providerName: string;
  argv: string[];
  appendPrompt: boolean;
  appendPromptSeparator?: boolean;
  expectStdout: RegExp;
}): Promise<void> {
  const { page, request, providerName, argv, appendPrompt, expectStdout } = opts;
  const appendPromptSeparator = opts.appendPromptSeparator ?? true;
  // Provider and command names are unique, and an isolated e2e stack keeps its DynamoDB
  // container across runs, so a fixed `claude` name would fail every run after the first.
  const catalogName = `${providerName}-${Date.now()}`;
  const hostId = `pw-real-${providerName}-${Date.now()}`;
  const repoId = `pw-real-repo-${providerName}-${Date.now()}`;
  const wtId = `wt-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), `pw-real-cli-${providerName}-`));
  const repo = join(root, "repo");
  const wt = join(root, wtId);
  let stopDaemon: (() => Promise<void>) | undefined;

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
      data: { name: catalogName },
    });
    expect(providerRes.ok(), `create provider failed: ${await providerRes.text()}`).toBeTruthy();
    const provider = await providerRes.json();

    await enableSessionLogUploadAlways(request);

    const commandRes = await request.post(`${API}/api/v1/commands`, {
      data: {
        name: `${catalogName}-print`,
        argv,
        appendPrompt,
        appendPromptSeparator,
        providerId: provider.id,
      },
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

    const repositoryRes = await request.post(`${API}/api/v1/repositories`, {
      data: { name: repoId, url: `https://example.test/${repoId}.git`, defaultBranch: "main" },
    });
    expect(
      repositoryRes.ok(),
      `create repository failed: ${await repositoryRes.text()}`,
    ).toBeTruthy();
    const repositoryId = ((await repositoryRes.json()) as { id: string }).id;
    const configRes = await request.put(`${API}/api/v1/hosts/${hostId}/inventory`, {
      data: {
        repositories: [
          {
            id: repositoryId,
            path: repo,
            defaultBranch: "main",
            worktrees: [{ id: wtId, name: wtId, path: wt, labels: [providerName] }],
          },
        ],
        providerAccounts: [{ providerAccountId: account.id }],
      },
    });
    expect(configRes.ok(), `attach account to host failed: ${await configRes.text()}`).toBeTruthy();

    // Real bootstrap fetch (GET /api/v1/hosts/:id/inventory), same as `pnpm local:daemon start`.
    const profilePath = join(root, "execution-profiles.json");
    writeFileSync(profilePath, JSON.stringify({ accounts: { [account.id]: { home: homedir() } } }));
    const config = await fetchHostInventory({
      hostId,
      apiUrl: API_BASE,
    });
    const daemon = await startDaemon({
      config,
      log: () => undefined,
      error: () => undefined,
      childEnvSource: { ...process.env, HARNESS_EXECUTION_PROFILES: profilePath },
    });
    stopDaemon = daemon.stop;
    await new Promise((r) => setTimeout(r, 200));

    await page.goto("/sessions/new");
    await expect(page.getByTestId("create-session-target")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("create-session-repository-id").selectOption(repositoryId);
    // Select by value, not label: a provider option's label is only the provider's name, which
    // does not identify it once earlier runs have left other providers behind.
    await page
      .getByTestId("create-session-target")
      .selectOption(encodeSessionTargetOptionValue({ kind: "provider", id: provider.id }));
    await page.getByTestId("create-session-prompt").fill(REAL_CLI_PROMPT);
    await page.getByTestId("create-session-timeout").selectOption("custom");
    await page.getByTestId("create-session-timeout-custom").fill("240");
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
    await stopDaemon?.();
    rmSync(root, { recursive: true, force: true });
  }
}
