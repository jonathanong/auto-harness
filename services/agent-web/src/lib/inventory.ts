import { emptyHostInventory, type HostInventory } from "@auto-harness/shared";

import { apiBase } from "./api.ts";

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
      commandProfiles:
        cfg.commandProfiles && typeof cfg.commandProfiles === "object"
          ? (cfg.commandProfiles as HostInventory["commandProfiles"])
          : emptyHostInventory().commandProfiles,
    };
  } catch {
    return emptyHostInventory();
  }
}
