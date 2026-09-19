import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, type APIRequestContext, test } from "@playwright/test";

import { fetchHostInventory } from "../../services/host-daemon/src/bootstrap.ts";
import { startDaemon } from "../../services/host-daemon/src/start-daemon.ts";
import { runCommand } from "../../scripts/lib/run-command.mts";
import { API_BASE } from "../harness-endpoints.ts";

const API = API_BASE;
const CLI_PATH = fileURLToPath(new URL("../../modules/client/src/cli/index.js", import.meta.url));

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runCommand("git", args, { cwd });
  expect(result.status, `git ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
}

/** Same CAS-retry shape as `e2e/real-cli/real-cli-helpers.ts`'s own helper — a shared,
 * process-wide setting, so parallel specs must not clobber each other's write. */
async function enableSessionLogUploadAlways(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const settingsRes = await request.get(`${API}/api/v1/session-log-settings`);
    expect(settingsRes.ok()).toBe(true);
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

function startSchedulerNudge(request: APIRequestContext) {
  let stopped = false;
  const interval = setInterval(() => {
    if (!stopped) request.post(`${API}/api/v1/scheduler/assign`).catch(() => undefined);
  }, 200);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/** Polls the control plane's own inventory record — authoritative the instant `host smoke`'s
 * `PUT` commits, no daemon involved — until it sees the repository attached, or throws once
 * `timeoutMs` elapses (a stuck attach step should fail the test loudly, not hang it). */
async function waitForAttachedRepository(
  request: APIRequestContext,
  hostId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get(`${API}/api/v1/hosts/${hostId}/inventory`);
    const inventory = (await res.json()) as { repositories?: unknown[] };
    if ((inventory.repositories ?? []).length > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`host ${hostId} never showed an attached repository within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Creates a Provider whose default Command runs `argv`, a bound ProviderAccount attached to
 * `hostId`'s inventory, and a clean temp git repo with `.worktrees/` gitignored — everything
 * `host smoke` itself does not create. */
export async function setupSmokeFixture(request: APIRequestContext, tag: string, argv: string[]) {
  const hostId = `pw-smoke-${tag}-${test.info().parallelIndex}-${Date.now()}`;
  const name = `smoke-e2e-${tag}-${test.info().parallelIndex}-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), `pw-cli-host-smoke-${tag}-`));
  const repoPath = join(root, "repo");

  mkdirSync(repoPath);
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "pw@pw"]);
  await git(repoPath, ["config", "user.name", "pw"]);
  writeFileSync(join(repoPath, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repoPath, "README"), `${tag}\n`);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "init"]);
  await git(repoPath, ["branch", "-M", "main"]);

  const providerRes = await request.post(`${API}/api/v1/providers`, { data: { name } });
  expect(providerRes.ok(), await providerRes.text()).toBeTruthy();
  const provider = await providerRes.json();

  await enableSessionLogUploadAlways(request);

  const commandRes = await request.post(`${API}/api/v1/commands`, {
    data: { name: `${name}-cmd`, argv, appendPrompt: true, providerId: provider.id },
  });
  expect(commandRes.ok(), await commandRes.text()).toBeTruthy();
  const command = await commandRes.json();

  const patchRes = await request.patch(`${API}/api/v1/providers/${provider.id}`, {
    data: { defaultCommandId: command.id },
  });
  expect(patchRes.ok(), await patchRes.text()).toBeTruthy();

  const accountRes = await request.post(`${API}/api/v1/provider-accounts`, {
    data: { providerId: provider.id, label: "e2e" },
  });
  expect(accountRes.ok(), await accountRes.text()).toBeTruthy();
  const account = await accountRes.json();

  const inventoryRes = await request.put(`${API}/api/v1/hosts/${hostId}/inventory`, {
    data: { repositories: [], providerAccounts: [{ providerAccountId: account.id }] },
  });
  expect(inventoryRes.ok(), await inventoryRes.text()).toBeTruthy();

  const profilePath = join(root, "execution-profiles.json");
  writeFileSync(profilePath, JSON.stringify({ accounts: { [account.id]: { home: homedir() } } }));

  return {
    hostId,
    providerId: provider.id,
    accountId: account.id,
    repoPath,
    profilePath,
    cleanupTempDir() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Runs the real CLI binary as a subprocess (never the API key, always against the e2e stack)
 * and, concurrently, brings up the host daemon — but only *after* `host smoke`'s own attach
 * step has actually committed. The daemon otherwise only learns about a newly attached
 * repository through its own periodic poll (there is no push-on-write; see
 * `services/host-daemon/src/start-daemon.ts`'s `startInventoryPoll`), and `host smoke` attaches
 * its own throwaway repository *after* a real daemon would already be running (its id does not
 * exist until the CLI itself creates it) — a daemon that connects with stale inventory rejects
 * the very next assignment with "Unknown repository" (`worktree-manager.ts`), which is not
 * retried (`services/api/src/session-transition-planner.ts` has no infra-retry classification
 * for it). Waiting for the attach to land in the control plane's own inventory record before
 * ever starting the daemon means its *first* config fetch is already correct — no poll, no
 * race: the session simply stays `queued` (the normal "no host yet" case) until this daemon
 * connects and registers, whose registration event assigns it correctly the first time.
 */
export async function runSmokeCli(
  fixture: Awaited<ReturnType<typeof setupSmokeFixture>>,
  request: APIRequestContext,
  tag: string,
) {
  const { HARNESS_API_KEY: _key, HARNESS_API_KEY_FILE: _keyFile, ...cleanEnv } = process.env;
  const cliPromise = runCommand(
    "node",
    [
      CLI_PATH,
      "host",
      "smoke",
      fixture.hostId,
      "--repo-path",
      fixture.repoPath,
      "--provider",
      fixture.providerId,
      "--timeout",
      "45",
      "--api-url",
      API,
      "--allow-insecure-http",
      "--json",
    ],
    { env: cleanEnv },
  );

  const stopNudge = startSchedulerNudge(request);
  await waitForAttachedRepository(request, fixture.hostId, 30_000);
  const config = await fetchHostInventory({ hostId: fixture.hostId, apiUrl: API });
  const daemon = await startDaemon({
    config,
    log: (line) => console.log(`[daemon:${tag}]`, line),
    error: (line) => console.log(`[daemon:${tag}:ERR]`, line),
    childEnvSource: { ...process.env, HARNESS_EXECUTION_PROFILES: fixture.profilePath },
  });

  try {
    return await cliPromise;
  } finally {
    stopNudge();
    await daemon.stop();
  }
}
