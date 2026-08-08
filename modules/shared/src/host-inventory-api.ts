import { apiBase } from "./api-client.ts";
import { emptyHostInventory, type HostInventory } from "./host-inventory.ts";

/**
 * Fetch inventory fresh right before a read-modify-write mutation. Callers should not
 * reuse a page-load-time `inventory` prop for this — another tab/action may have
 * changed it since, and PUT replaces the whole document (lost-update risk).
 */
export async function getInventory(hostId: string): Promise<HostInventory> {
  const res = await fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(hostId)}/config`, {
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
}

export async function putInventory(
  hostId: string,
  inv: HostInventory,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(hostId)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositories: inv.repositories,
      providerAccounts: inv.providerAccounts,
      commandProfiles: inv.commandProfiles,
      ...(inv.logLevel !== undefined ? { logLevel: inv.logLevel } : {}),
    }),
  });
  if (!res.ok) {
    return { ok: false, error: await res.text() };
  }
  return { ok: true };
}
