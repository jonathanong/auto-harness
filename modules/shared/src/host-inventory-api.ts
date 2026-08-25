import { apiBase, apiErrorMessage } from "./api-client.ts";
import { parseRequiredEnvironment } from "./environment-requirements.ts";
import { emptyHostInventory, type HostInventory } from "./host-inventory.ts";
import { isHostCapability, normalizeHostCapabilities } from "./host-capabilities.ts";
import type { HostExecConfigPatch } from "./host-exec-config.ts";
import { parseHostUpdateConfig } from "./host-update-config.ts";

/**
 * Fetch inventory fresh right before a read-modify-write mutation. Callers should not
 * reuse a page-load-time `inventory` prop for this — another tab/action may have
 * changed it since, and PUT replaces the whole document (lost-update risk).
 */
export async function getInventory(hostId: string): Promise<HostInventory> {
  return (await readInventory(hostId)).inventory;
}

/**
 * Read the inventory together with the version it was read at, so a following write can
 * be made conditional on nothing else having changed it.
 */
async function readInventory(
  hostId: string,
): Promise<{ inventory: HostInventory; version: number }> {
  // `cache` is a browser fetch option outside @types/node's RequestInit; this path
  // only ever runs in the browser/RSC, never from a non-DOM consumer like the daemon.
  const res = await fetch(`${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`, {
    cache: "no-store",
  } as RequestInit);
  if (!res.ok) {
    if (res.status === 404) return { inventory: emptyHostInventory(), version: 0 };
    throw new Error(await apiErrorMessage(res));
  }
  const cfg = (await res.json()) as Record<string, unknown>;
  const version = typeof cfg.version === "number" ? cfg.version : 0;
  const requiredEnvironment = parseRequiredEnvironment(cfg.requiredEnvironment);
  return {
    version,
    inventory: {
      ...(typeof cfg.setupScript === "string" ? { setupScript: cfg.setupScript } : {}),
      ...(Array.isArray(cfg.allowedRoots) &&
      cfg.allowedRoots.every((root) => typeof root === "string")
        ? { allowedRoots: cfg.allowedRoots as string[] }
        : {}),
      ...(requiredEnvironment.length ? { requiredEnvironment } : {}),
      ...(cfg.updateConfig === undefined
        ? {}
        : { updateConfig: parseHostUpdateConfig(cfg.updateConfig) }),
      repositories: Array.isArray(cfg.repositories)
        ? (cfg.repositories as HostInventory["repositories"])
        : [],
      providerAccounts: Array.isArray(cfg.providerAccounts)
        ? (cfg.providerAccounts as HostInventory["providerAccounts"])
        : [],
      capabilities: Array.isArray(cfg.capabilities)
        ? normalizeHostCapabilities(cfg.capabilities.filter(isHostCapability))
        : [],
    },
  };
}

export async function putInventory(
  hostId: string,
  inv: HostInventory,
  version?: number,
): Promise<{ ok: true } | { ok: false; error: string; conflict?: true }> {
  const res = await fetch(`${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(inv.setupScript !== undefined ? { setupScript: inv.setupScript } : {}),
      ...(inv.allowedRoots !== undefined ? { allowedRoots: inv.allowedRoots } : {}),
      ...(inv.requiredEnvironment !== undefined
        ? { requiredEnvironment: inv.requiredEnvironment }
        : {}),
      ...(inv.updateConfig !== undefined ? { updateConfig: inv.updateConfig } : {}),
      repositories: inv.repositories,
      providerAccounts: inv.providerAccounts,
      ...(inv.capabilities !== undefined ? { capabilities: inv.capabilities } : {}),
      ...(version !== undefined ? { version } : {}),
    }),
  });
  if (!res.ok) {
    return writeFailure(res);
  }
  return { ok: true };
}

async function writeFailure(res: Response): Promise<{ ok: false; error: string; conflict?: true }> {
  return {
    ok: false,
    ...(res.status === 409 ? { conflict: true as const } : {}),
    error: await apiErrorMessage(res),
  };
}

export async function putExecConfig(
  hostId: string,
  patch: HostExecConfigPatch,
  version?: number,
): Promise<{ ok: true } | { ok: false; error: string; conflict?: true }> {
  const res = await fetch(`${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/exec-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(patch.setupScript !== undefined ? { setupScript: patch.setupScript } : {}),
      ...(patch.allowedRoots !== undefined ? { allowedRoots: patch.allowedRoots } : {}),
      ...(patch.updateConfig !== undefined ? { updateConfig: patch.updateConfig } : {}),
      ...(patch.repositories !== undefined ? { repositories: patch.repositories } : {}),
      ...(version !== undefined ? { version } : {}),
    }),
  });
  if (!res.ok) return writeFailure(res);
  return { ok: true };
}

export async function putHostUpdateConfig(
  hostId: string,
  updateConfig: import("./host-update-config.ts").HostUpdateConfig,
  version?: number,
): Promise<{ ok: true } | { ok: false; error: string; conflict?: true }> {
  const res = await fetch(`${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/update-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updateConfig, ...(version !== undefined ? { version } : {}) }),
  });
  if (!res.ok) return writeFailure(res);
  return { ok: true };
}

/** How many times a losing writer re-reads and reapplies before giving up. */
const MUTATE_ATTEMPTS = 3;

type MutationResult = { ok: true } | { ok: false; error: string; conflict?: true };

async function mutateWithFence<T>(
  hostId: string,
  mutate: (current: HostInventory) => T,
  write: (hostId: string, payload: T, version: number) => Promise<MutationResult>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let last: { ok: false; error: string; conflict?: true } = {
    ok: false,
    error: "host inventory changed while saving; try again",
  };
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    let inventory: HostInventory;
    let version: number;
    try {
      ({ inventory, version } = await readInventory(hostId));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const result = await write(hostId, mutate(inventory), version);
    if (result.ok) return result;
    if (!result.conflict) return result;
    last = result;
  }
  return { ok: false, error: last.error };
}

/**
 * Read-modify-write an inventory safely.
 *
 * PUT replaces the whole document, so two editors working from their own reads used to
 * silently discard one another's changes — and the worktree projection then deleted the
 * rows belonging to the lost edit. Every caller here re-reads immediately before writing
 * and conditions the write on that read, reapplying `mutate` if it lost the race. Callers
 * must not build the write from a page-load-time `inventory` prop.
 */
export async function mutateInventory(
  hostId: string,
  mutate: (current: HostInventory) => HostInventory,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return mutateWithFence(hostId, mutate, putInventory);
}

/**
 * Read-modify-write host exec-config (setup scripts, terminal hooks, allowed roots)
 * against the same inventory version fence.
 */
export async function mutateExecConfig(
  hostId: string,
  patch: (current: HostInventory) => HostExecConfigPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return mutateWithFence(hostId, patch, putExecConfig);
}

/** Read-modify-write the signed-update settings with the host inventory CAS fence. */
export async function mutateHostUpdateConfig(
  hostId: string,
  updateConfig: import("./host-update-config.ts").HostUpdateConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return await mutateWithFence(
    hostId,
    () => updateConfig,
    (id, value, version) => putHostUpdateConfig(id, value, version),
  );
}
