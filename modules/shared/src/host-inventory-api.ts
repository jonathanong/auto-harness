import { apiBase, apiErrorMessage } from "./api-client.ts";
import { emptyHostInventory, type HostInventory } from "./host-inventory.ts";
import { isHostCapability, normalizeHostCapabilities } from "./host-capabilities.ts";

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
    return { inventory: emptyHostInventory(), version: 0 };
  }
  const cfg = (await res.json()) as Record<string, unknown>;
  const version = typeof cfg.version === "number" ? cfg.version : 0;
  return {
    version,
    inventory: {
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
      repositories: inv.repositories,
      providerAccounts: inv.providerAccounts,
      ...(inv.capabilities !== undefined ? { capabilities: inv.capabilities } : {}),
      ...(version !== undefined ? { version } : {}),
    }),
  });
  if (!res.ok) {
    return {
      ok: false,
      ...(res.status === 409 ? { conflict: true as const } : {}),
      error: await apiErrorMessage(res),
    };
  }
  return { ok: true };
}

/** How many times a losing writer re-reads and reapplies before giving up. */
const MUTATE_ATTEMPTS = 3;

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
  let last: { ok: false; error: string; conflict?: true } = {
    ok: false,
    error: "host inventory changed while saving; try again",
  };
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const { inventory, version } = await readInventory(hostId);
    const result = await putInventory(hostId, mutate(inventory), version);
    if (result.ok) return result;
    if (!result.conflict) return result;
    last = result;
  }
  return { ok: false, error: last.error };
}
