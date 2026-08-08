import { upsertHostRepository, type HostInventory } from "@auto-harness/shared";

import { apiBase } from "./api.ts";

/**
 * Attach an existing catalog repository's local path to a host.
 * Does not invent worktrees — add those on the agent host config UI.
 */
export async function attachLocalRepo(input: {
  hostId: string;
  id: string;
  path: string;
  defaultBranch: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  let existing: HostInventory | null = null;
  const get = await fetch(`${base}/api/v1/hosts/${encodeURIComponent(input.hostId)}/inventory`);
  if (get.ok) {
    existing = (await get.json()) as HostInventory;
  }

  const host = upsertHostRepository(existing, {
    id: input.id,
    path: input.path,
    defaultBranch: input.defaultBranch,
  });

  const put = await fetch(`${base}/api/v1/hosts/${encodeURIComponent(input.hostId)}/inventory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(host),
  });
  if (!put.ok) {
    return { ok: false, error: await put.text() };
  }
  return { ok: true };
}
