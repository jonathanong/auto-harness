import type { HostInventoryRecord } from "./db/plane-storage.ts";
import type { WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { parseHostBody } from "./control-plane-agent-hosts-parse.ts";
import { findWorktreeNameCollision } from "./control-plane-worktree-names.ts";
import {
  getHostInventoryDurable,
  listHostInventoriesDurable,
} from "./control-plane-durable-read-catalog.ts";
import { listWorktreesDurable } from "./control-plane-durable-read-runtime.ts";
import { inventoryReferenceMarkers } from "./control-plane-delete-reference-markers.ts";

function syncWorktreesFromHost(
  state: ControlPlaneState,
  host: HostInventoryRecord,
  persist: boolean,
): void {
  const { worktrees, removedIds } = projectHostWorktrees(state, host);
  for (const worktree of worktrees) {
    if (persist) persistWorktree(state, worktree);
    else state.worktrees.set(worktree.id, worktree);
  }
  for (const id of removedIds) state.worktrees.delete(id);
}

function projectHostWorktrees(
  state: ControlPlaneState,
  host: HostInventoryRecord,
): { worktrees: WorktreeRecord[]; removedIds: string[] } {
  const online = state.hostConnection.has(host.hostId);
  const configuredIds = new Set<string>();
  const worktrees: WorktreeRecord[] = [];
  for (const repo of host.repositories) {
    for (const wt of repo.worktrees) {
      configuredIds.add(wt.id);
      const prev = state.worktrees.get(wt.id);
      const next: WorktreeRecord = {
        id: wt.id,
        name: wt.name,
        hostId: host.hostId,
        repositoryId: repo.id,
        path: wt.path,
        labels: wt.labels,
        status: prev && prev.status === "busy" ? "busy" : "idle",
        online: prev ? prev.online : online,
        currentSessionId: prev && prev.currentSessionId != null ? prev.currentSessionId : null,
        lastAssignedAt: prev && prev.lastAssignedAt != null ? prev.lastAssignedAt : null,
      };
      worktrees.push(next);
    }
  }
  // Host inventory is authoritative: drop worktrees no longer listed for this agent.
  const removedIds: string[] = [];
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === host.hostId && !configuredIds.has(id) && wt.status !== "busy") {
      removedIds.push(id);
    }
  }
  return { worktrees, removedIds };
}

export function putHostInventory(
  state: ControlPlaneState,
  hostId: string,
  body: unknown,
): { ok: true; config: HostInventoryRecord } | { ok: false; error: string } {
  try {
    const result = prepareHostInventory(state, hostId, body);
    if (!result.ok) return result;
    const rec = result.config;
    state.hostInventories.set(hostId, rec);
    if (state.storage) {
      queueWrite(state, state.storage.putHostInventory({ ...rec }));
    }
    syncWorktreesFromHost(state, rec, true);
    return { ok: true, config: { ...rec } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function prepareHostInventory(
  state: ControlPlaneState,
  hostId: string,
  body: unknown,
): { ok: true; config: HostInventoryRecord } | { ok: false; error: string } {
  try {
    const parsed = parseHostBody(hostId, body);
    const collision = findWorktreeNameCollision(state, hostId, parsed);
    if (collision) return { ok: false, error: collision };
    return { ok: true, config: { ...parsed, updatedAt: state.now() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist host configuration before changing cached inventory or derived worktrees. */
export async function putHostInventoryDurable(
  state: ControlPlaneState,
  hostId: string,
  body: unknown,
): Promise<ReturnType<typeof putHostInventory>> {
  if (!state.storage) return putHostInventory(state, hostId, body);
  await Promise.all([listHostInventoriesDurable(state), listWorktreesDurable(state)]);
  const result = prepareHostInventory(state, hostId, body);
  if (!result.ok) return result;
  const projection = projectHostWorktrees(state, result.config);
  await state.storage.putHostInventory(
    { ...result.config },
    inventoryReferenceMarkers(state.now(), result.config),
  );
  await Promise.all([
    ...projection.worktrees.map((worktree) => state.storage!.putWorktree({ ...worktree })),
    ...projection.removedIds.map((id) => state.storage!.deleteWorktree(id)),
  ]);
  state.hostInventories.set(hostId, result.config);
  for (const worktree of projection.worktrees) state.worktrees.set(worktree.id, worktree);
  for (const id of projection.removedIds) state.worktrees.delete(id);
  return { ok: true, config: { ...result.config } };
}

export function getHostInventory(
  state: ControlPlaneState,
  hostId: string,
): HostInventoryRecord | null {
  const rec = state.hostInventories.get(hostId);
  return rec ? { ...rec } : null;
}

export function listHostInventories(state: ControlPlaneState): HostInventoryRecord[] {
  return [...state.hostInventories.values()]
    .toSorted((a, b) => a.hostId.localeCompare(b.hostId))
    .map((h) => ({ ...h }));
}

export function deleteHostInventory(
  state: ControlPlaneState,
  hostId: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.hostInventories.has(hostId)) {
    return { ok: false, error: "agent host config not found" };
  }
  state.hostInventories.delete(hostId);
  if (state.storage) {
    queueWrite(state, state.storage.deleteHostInventory(hostId));
  }
  // The host is gone entirely, so its worktree names must be released too —
  // otherwise they stay permanently reserved against a host that no longer exists.
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === hostId) {
      state.worktrees.delete(id);
    }
  }
  return { ok: true };
}

/** Delete durable inventory before releasing its cached worktree projection. */
export async function deleteHostInventoryDurable(
  state: ControlPlaneState,
  hostId: string,
): Promise<ReturnType<typeof deleteHostInventory>> {
  if (!state.storage) return deleteHostInventory(state, hostId);
  if (!(await getHostInventoryDurable(state, hostId))) {
    return { ok: false, error: "agent host config not found" };
  }
  await listWorktreesDurable(state);
  const worktreeIds = [...state.worktrees.values()]
    .filter((worktree) => worktree.hostId === hostId)
    .map((worktree) => worktree.id);
  await state.storage.deleteHostInventory(hostId);
  await Promise.all(worktreeIds.map((id) => state.storage!.deleteWorktree(id)));
  state.hostInventories.delete(hostId);
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === hostId) state.worktrees.delete(id);
  }
  return { ok: true };
}
