import { emptyHostInventory, type HostInventory } from "@auto-harness/shared";
import type { RepoCatalogEntry } from "@auto-harness/ui";

import { apiGet } from "./api.ts";

type LiveWorktree = { status?: string; online?: boolean };

/** Control-plane worktree status/online for this agent, keyed by worktree id. */
export async function loadLiveWorktreesById(hostId: string): Promise<Record<string, LiveWorktree>> {
  try {
    const data = await apiGet<{
      items: Array<{ id: string; hostId?: string; status?: string; online?: boolean }>;
    }>("/api/v1/worktrees");
    const out: Record<string, LiveWorktree> = {};
    for (const w of data.items ?? []) {
      if (w.hostId === hostId) {
        out[w.id] = { status: w.status, online: w.online };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Full catalog repository list, sorted by name — used for repo pickers. */
export async function loadRepoCatalog(): Promise<RepoCatalogEntry[]> {
  try {
    const data = await apiGet<{ items: RepoCatalogEntry[] }>("/api/v1/repositories");
    return (data.items ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Catalog repository name, keyed by id — a HostRepository has no name of its
 * own (only the global catalog does); id -> name may be missing if the host
 * inventory references a catalog id that was since deleted.
 */
export async function loadRepoNamesById(): Promise<Record<string, string>> {
  const catalog = await loadRepoCatalog();
  return Object.fromEntries(catalog.map((r) => [r.id, r.name]));
}

export async function loadHostInventory(hostId: string): Promise<HostInventory> {
  try {
    const cfg = await apiGet<Record<string, unknown>>(
      `/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
    );
    return {
      repositories: Array.isArray(cfg.repositories)
        ? (cfg.repositories as HostInventory["repositories"])
        : [],
      providerAccounts: Array.isArray(cfg.providerAccounts)
        ? (cfg.providerAccounts as HostInventory["providerAccounts"])
        : [],
    };
  } catch {
    return emptyHostInventory();
  }
}
