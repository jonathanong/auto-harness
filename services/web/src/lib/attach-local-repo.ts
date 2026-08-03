import { mergeHostRepository, type HostInventory } from "@auto-harness/shared";

import { apiBase } from "./api.ts";

/**
 * Register a repo on the control plane and attach host paths to an agent.
 * Same behavior as agent-pane "Add local repo".
 */
export async function attachLocalRepo(input: {
  agentId: string;
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  worktreeId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  const repoRes = await fetch(`${base}/api/v1/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: input.id,
      name: input.name || input.id,
      url: input.path,
      defaultBranch: input.defaultBranch,
    }),
  });
  if (!repoRes.ok && repoRes.status !== 400) {
    return { ok: false, error: await repoRes.text() };
  }

  let existing: HostInventory | null = null;
  const get = await fetch(`${base}/api/v1/agents/${encodeURIComponent(input.agentId)}/config`);
  if (get.ok) {
    existing = (await get.json()) as HostInventory;
  }

  const host = mergeHostRepository(existing, {
    id: input.id,
    path: input.path,
    defaultBranch: input.defaultBranch,
    worktreeId: input.worktreeId,
  });

  const put = await fetch(`${base}/api/v1/agents/${encodeURIComponent(input.agentId)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(host),
  });
  if (!put.ok) {
    return { ok: false, error: await put.text() };
  }
  return { ok: true };
}
