import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { API_BASE, API_PORT } from "./harness-endpoints.ts";

const API = API_BASE;
// Keyed by API_PORT, not a fixed name: os.tmpdir() is a single machine-wide directory, and
// worktree-e2e-env.mts gives each worktree's isolated e2e run its own HARNESS_E2E_PORT_OFFSET
// (hence its own API_PORT). A fixed lock name would serialize unrelated control-plane instances
// against each other across worktrees running concurrently, timing out for no reason — this
// still correctly serializes the Playwright worker *processes* of one run, which all share the
// same API_PORT and are exactly what the lock is meant to protect (see withLocalHostLock below).
const LOCK_DIR = join(tmpdir(), `auto-harness-e2e-local-1-${API_PORT}.lock`);

/**
 * "local-1" is the one agent both e2e projects seed against — the host pane's UI is
 * bound to it directly (no way to target a different agent), and several control-plane
 * specs reuse it too rather than register a second live agent. Every test that mutates
 * its host config does a full-document read-modify-write PUT (there's no partial-update
 * API), so two tests running in parallel can race: both read the same snapshot, and
 * whichever PUT lands second silently drops the other's addition (lost update). A
 * one-shot post-write verification doesn't fully fix this either — a *slower* concurrent
 * test can still land its own stale-snapshot write later and clobber an entry that had
 * already verified fine. The only fully correct fix is mutual exclusion for each test's
 * entire setup → assertions → teardown lifecycle, so no other writer can interleave at
 * all. Playwright workers are separate OS processes (no shared memory for an in-process
 * mutex), so this uses an exclusive-directory-create lockfile instead.
 *
 * Every test that reads or writes local-1's host config must wrap its whole body in
 * this — not just the mutation — including tests that only read it while another test
 * might be mid-write.
 */
export async function withLocalHostLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > 30_000) {
        throw new Error("withLocalHostLock: timed out waiting for the local-1 host-config lock", {
          cause: err,
        });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
}

type HostRepo = {
  id: string;
  path: string;
  defaultBranch: string;
  worktrees: Array<{ id: string; name: string; path: string; labels: string[] }>;
};

async function getConfig(request: APIRequestContext) {
  const res = await request.get(`${API}/api/v1/hosts/local-1/inventory`);
  return res.ok() ? await res.json() : { repositories: [], providerAccounts: [] };
}

/** Caller must hold withLocalHostLock for the duration of use. */
export async function putHostRepo(request: APIRequestContext, repo: HostRepo): Promise<void> {
  const cfg = await getConfig(request);
  const repositories = [
    ...(cfg.repositories ?? []).filter((r: { id: string }) => r.id !== repo.id),
    repo,
  ];
  await request.put(`${API}/api/v1/hosts/local-1/inventory`, {
    data: {
      repositories,
      providerAccounts: cfg.providerAccounts ?? [],
    },
  });
}

/** Caller must hold withLocalHostLock for the duration of use. */
export async function removeHostRepo(request: APIRequestContext, repoId: string): Promise<void> {
  const cfg = await getConfig(request);
  const repositories = (cfg.repositories ?? []).filter((r: { id: string }) => r.id !== repoId);
  await request.put(`${API}/api/v1/hosts/local-1/inventory`, {
    data: {
      repositories,
      providerAccounts: cfg.providerAccounts ?? [],
    },
  });
}

/**
 * Caller must hold withLocalHostLock for the duration of use. Submitting
 * navigates straight to the new repository's detail page (toast + navigate
 * on success) — the dialog unmounts along with the rest of the list page.
 */
export async function attachRepoViaUi(
  page: Page,
  repo: { name: string; path: string },
): Promise<void> {
  await page.getByTestId("add-repo-open").click();
  await expect(page.getByTestId("add-repo-dialog")).toBeVisible();
  await page.getByTestId("add-repo-catalog-id").selectOption({ label: repo.name });
  await page.getByTestId("add-repo-path").fill(repo.path);
  await page.getByTestId("add-repo-submit").click();
  await expect(page.getByTestId("page-repository-detail")).toBeVisible({ timeout: 15_000 });
}
