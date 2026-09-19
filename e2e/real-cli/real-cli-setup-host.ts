import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";

import { fetchHostInventory } from "../../services/host-daemon/src/bootstrap.ts";
import { startDaemon } from "../../services/host-daemon/src/start-daemon.ts";
import { API_BASE } from "../harness-endpoints.ts";

const API = API_BASE;

/** Create a Provider Account, optionally with a short usage-limit cooldown for a fast test. */
export async function createProviderAccount(
  request: APIRequestContext,
  opts: { providerId: string; label: string; usageLimitCooldownSeconds?: number },
): Promise<{ id: string }> {
  const accountRes = await request.post(`${API}/api/v1/provider-accounts`, {
    data: {
      providerId: opts.providerId,
      label: opts.label,
      ...(opts.usageLimitCooldownSeconds !== undefined
        ? { usageLimitCooldownSeconds: opts.usageLimitCooldownSeconds }
        : {}),
    },
  });
  expect(
    accountRes.ok(),
    `create provider account failed: ${await accountRes.text()}`,
  ).toBeTruthy();
  return (await accountRes.json()) as { id: string };
}

/**
 * Register a repository and attach a single host's inventory: one repository with one
 * worktree, plus the given Provider Accounts (per the control-plane-does-everything
 * invariant, attaching a host's inventory is itself a control-plane REST call).
 */
export async function attachRealCliHostInventory(
  request: APIRequestContext,
  opts: {
    hostId: string;
    repoId: string;
    repoPath: string;
    wtId: string;
    wtPath: string;
    labels: string[];
    providerAccountIds: string[];
  },
): Promise<{ repositoryId: string }> {
  const repositoryRes = await request.post(`${API}/api/v1/repositories`, {
    data: {
      name: opts.repoId,
      url: `https://example.test/${opts.repoId}.git`,
      defaultBranch: "main",
    },
  });
  expect(
    repositoryRes.ok(),
    `create repository failed: ${await repositoryRes.text()}`,
  ).toBeTruthy();
  const repositoryId = ((await repositoryRes.json()) as { id: string }).id;

  const configRes = await request.put(`${API}/api/v1/hosts/${opts.hostId}/inventory`, {
    data: {
      repositories: [
        {
          id: repositoryId,
          path: opts.repoPath,
          defaultBranch: "main",
          worktrees: [{ id: opts.wtId, name: opts.wtId, path: opts.wtPath, labels: opts.labels }],
        },
      ],
      providerAccounts: opts.providerAccountIds.map((providerAccountId) => ({ providerAccountId })),
    },
  });
  expect(configRes.ok(), `attach account to host failed: ${await configRes.text()}`).toBeTruthy();
  return { repositoryId };
}

/**
 * Start a real, in-process agent daemon (real WS, real subprocess) for one host, with an
 * execution profile giving every listed Provider Account the caller's own `HOME` — where
 * the real CLI is already logged in. Real bootstrap fetch (`GET /hosts/:id/inventory`),
 * same as `pnpm local:daemon start`.
 */
export async function startRealCliDaemon(opts: {
  hostId: string;
  root: string;
  providerAccountIds: string[];
}): Promise<{ stop: () => Promise<void> }> {
  const profilePath = join(opts.root, "execution-profiles.json");
  const accounts = Object.fromEntries(
    opts.providerAccountIds.map((id) => [id, { home: homedir() }]),
  );
  writeFileSync(profilePath, JSON.stringify({ accounts }));
  const config = await fetchHostInventory({ hostId: opts.hostId, apiUrl: API_BASE });
  const daemon = await startDaemon({
    config,
    log: () => undefined,
    error: () => undefined,
    childEnvSource: { ...process.env, HARNESS_EXECUTION_PROFILES: profilePath },
  });
  // Give the daemon a moment to finish its WS handshake before sessions are assigned to it.
  await new Promise((r) => setTimeout(r, 200));
  return daemon;
}
