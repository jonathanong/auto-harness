import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, type APIRequestContext, test } from "@playwright/test";

import { fetchHostInventory } from "../../services/host-daemon/src/bootstrap.ts";
import { startDaemon } from "../../services/host-daemon/src/start-daemon.ts";
import { runCommand } from "../../scripts/lib/run-command.mts";
import { API_BASE as API } from "../harness-endpoints.ts";
import { E2E_REPORTING_REPOSITORIES } from "../reporting-fixture.ts";

const CLI_PATH = fileURLToPath(new URL("../../modules/client/src/cli/index.js", import.meta.url));

// Disable the periodic poll. The host already owns its inventory attachment; command dispatch
// must use the daemon's assignment-scoped inventory refresh.
const DAEMON_INVENTORY_POLL_MS = 0;

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

/** Nudge queued work as other real-daemon specs do; creation also attempts assignment. */
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

/** Creates a Provider whose default Command runs `argv`, a bound ProviderAccount, a
 * policy-scoped repository attachment with one real worktree, and an already-running daemon.
 * Points
 * `HARNESS_EXECUTION_PROFILES` at a directory under this fixture's own temp root, never the
 * real home: `echo`/`false` need no provider credentials, unlike the real-CLI specs this
 * mirrors. */
export async function setupSmokeFixture(
  request: APIRequestContext,
  tag: "echo" | "false",
  argv: string[],
) {
  const repositoryId = E2E_REPORTING_REPOSITORIES[tag === "echo" ? "smokeEcho" : "smokeFailure"].id;
  const hostId = `pw-smoke-${tag}-${test.info().parallelIndex}-${Date.now()}`;
  const name = `smoke-e2e-${tag}-${test.info().parallelIndex}-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), `pw-cli-host-smoke-${tag}-`));
  const repoPath = join(root, "repo");
  const worktreeId = `smoke-worktree-${test.info().parallelIndex}-${Date.now()}`;
  const worktreePath = join(repoPath, ".worktrees", worktreeId);
  const home = join(root, "home");

  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let stopNudge: (() => void) | undefined;
  let inventoryOwned = false;
  let cleanedUp = false;
  // Built before any resource below is created, and safe to call more than once, so both the
  // catch below (setup failed partway) and the spec's own `finally` (setup succeeded) can call
  // it — same shutdown order as orchestration.spec.ts's `stopDaemon`/`rmSync` finally: stop
  // taking new work (the nudge), stop the daemon, then reclaim the filesystem last.
  const cleanup = async () => {
    if (cleanedUp) return;
    stopNudge?.();
    await daemon?.stop();
    if (inventoryOwned) {
      const inventory = await request.get(`${API}/api/v1/hosts/${hostId}/inventory`);
      expect(inventory.ok()).toBe(true);
      const record = (await inventory.json()) as {
        repositories: Array<{ id: string; path: string; worktrees: Array<{ id: string }> }>;
      };
      expect(record.repositories).toEqual([
        expect.objectContaining({
          id: repositoryId,
          path: repoPath,
          worktrees: [expect.objectContaining({ id: worktreeId })],
        }),
      ]);
      const removed = await request.delete(`${API}/api/v1/hosts/${hostId}/inventory`);
      expect(removed.status()).toBe(204);
    }
    rmSync(root, { recursive: true, force: true });
    cleanedUp = true;
  };

  try {
    mkdirSync(repoPath);
    mkdirSync(home);
    await git(repoPath, ["init"]);
    await git(repoPath, ["config", "user.email", "pw@pw"]);
    await git(repoPath, ["config", "user.name", "pw"]);
    writeFileSync(join(repoPath, ".gitignore"), ".worktrees/\n");
    writeFileSync(join(repoPath, "README"), `${tag}\n`);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "init"]);
    await git(repoPath, ["branch", "-M", "main"]);
    await git(repoPath, ["worktree", "add", "-b", worktreeId, worktreePath, "HEAD"]);

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
      data: {
        repositories: [
          {
            id: repositoryId,
            path: repoPath,
            defaultBranch: "main",
            worktrees: [
              {
                id: worktreeId,
                name: worktreeId,
                path: worktreePath,
                labels: [],
              },
            ],
          },
        ],
        providerAccounts: [{ providerAccountId: account.id }],
      },
    });
    expect(inventoryRes.ok(), await inventoryRes.text()).toBeTruthy();
    inventoryOwned = true;

    const profilePath = join(root, "execution-profiles.json");
    writeFileSync(profilePath, JSON.stringify({ accounts: { [account.id]: { home } } }));
    const config = await fetchHostInventory({ hostId, apiUrl: API });
    daemon = await startDaemon({
      config,
      identity: { hostId, apiUrl: API },
      log: (line) => console.log(`[daemon:${tag}]`, line),
      error: (line) => console.log(`[daemon:${tag}:ERR]`, line),
      inventoryPollMs: DAEMON_INVENTORY_POLL_MS,
      childEnvSource: { ...process.env, HARNESS_EXECUTION_PROFILES: profilePath },
    });
    stopNudge = startSchedulerNudge(request);

    return {
      hostId,
      repositoryId,
      providerId: provider.id,
      accountId: account.id,
      repoPath,
      worktreeId,
      worktreePath,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Runs the real CLI binary as a subprocess — never the API key, always against the e2e stack. */
export function runSmokeCli(
  hostId: string,
  repoPath: string,
  providerId: string,
  repositoryId: string,
) {
  const { HARNESS_API_KEY: _key, HARNESS_API_KEY_FILE: _keyFile, ...cleanEnv } = process.env;
  return runCommand(
    "node",
    [
      CLI_PATH,
      "host",
      "smoke",
      hostId,
      "--repository-id",
      repositoryId,
      "--repo-path",
      repoPath,
      "--provider",
      providerId,
      "--timeout",
      "45",
      "--api-url",
      API,
      "--allow-insecure-http",
      "--json",
    ],
    { env: cleanEnv },
  );
}
