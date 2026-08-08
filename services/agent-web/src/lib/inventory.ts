import { emptyHostInventory, type HostInventory } from "@auto-harness/shared";
import type { RepoCatalogEntry } from "@auto-harness/ui";

import { apiBase, apiGet } from "./api.ts";

type LiveWorktree = { status?: string; online?: boolean };

/** Control-plane worktree status/online for this agent, keyed by worktree id. */
export async function loadLiveWorktreesById(
  agentId: string,
): Promise<Record<string, LiveWorktree>> {
  try {
    const data = await apiGet<{
      items: Array<{ id: string; agentId?: string; status?: string; online?: boolean }>;
    }>("/api/v1/worktrees");
    const out: Record<string, LiveWorktree> = {};
    for (const w of data.items ?? []) {
      if (w.agentId === agentId) {
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

export async function loadHostInventory(agentId: string): Promise<HostInventory> {
  try {
    const res = await fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(agentId)}/config`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return emptyHostInventory();
    }
    const cfg = (await res.json()) as Record<string, unknown>;
    return {
      repositories: Array.isArray(cfg.repositories)
        ? (cfg.repositories as HostInventory["repositories"])
        : [],
      providerAccounts: Array.isArray(cfg.providerAccounts)
        ? (cfg.providerAccounts as HostInventory["providerAccounts"])
        : [],
      commandProfiles:
        cfg.commandProfiles && typeof cfg.commandProfiles === "object"
          ? (cfg.commandProfiles as HostInventory["commandProfiles"])
          : emptyHostInventory().commandProfiles,
      ...(cfg.logLevel === "debug" ||
      cfg.logLevel === "info" ||
      cfg.logLevel === "warn" ||
      cfg.logLevel === "error"
        ? { logLevel: cfg.logLevel }
        : {}),
    };
  } catch {
    return emptyHostInventory();
  }
}
