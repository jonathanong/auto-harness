import type { HostInventory } from "@auto-harness/shared";

import { apiBase } from "../lib/api.ts";

export async function putInventory(
  agentId: string,
  inv: HostInventory,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(agentId)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositories: inv.repositories,
      commandProfiles: inv.commandProfiles,
    }),
  });
  if (!res.ok) {
    return { ok: false, error: await res.text() };
  }
  return { ok: true };
}
