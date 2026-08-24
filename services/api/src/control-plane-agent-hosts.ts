/* eslint-disable max-lines -- durable inventory projections and version-fenced mutations share one state boundary. */
import type { DynamoPlaneStorage, HostInventoryRecord } from "./db/plane-storage.ts";
import type { WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { parseHostBody } from "./control-plane-agent-hosts-parse.ts";
import {
  preservedDaemonRuntime,
  withoutDaemonLabelProvenance,
} from "./control-plane-agent-registration.ts";
import { findWorktreeNameCollision } from "./control-plane-worktree-names.ts";
import {
  getHostInventoryDurable,
  listHostInventoriesDurable,
} from "./control-plane-durable-read-catalog.ts";
import { listWorktreesDurable } from "./control-plane-durable-read-runtime.ts";
import { inventoryReferenceMarkers } from "./control-plane-delete-reference-markers.ts";

function syncWorktreesFromHost(state: ControlPlaneState, host: HostInventoryRecord): void {
  const { worktrees, removedIds } = projectHostWorktrees(state, host);
  for (const worktree of worktrees) {
    persistWorktree(state, worktree);
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
  options: { allowLegacyRelativeTerminalHooks?: boolean } = {},
): InventoryWriteResult {
  const expectedVersion =
    expectedVersionFrom(body) ?? state.hostInventories.get(hostId)?.version ?? 0;
  if ((state.hostInventories.get(hostId)?.version ?? 0) !== expectedVersion) {
    return inventoryVersionConflict();
  }
  const result = prepareHostInventory(state, hostId, body, options);
  if (!result.ok) return result;
  const rec = result.config;
  state.hostInventories.set(hostId, rec);
  state.hostInventoryRevision += 1;
  if (state.storage) {
    queueWrite(state, (storage) =>
      storage!.putHostInventory({ ...rec }, undefined, expectedVersion),
    );
  }
  syncWorktreesFromHost(state, rec);
  return { ok: true, config: withoutDaemonLabelProvenance(rec) };
}

type InventoryWriteResult =
  | { ok: true; config: HostInventoryRecord }
  | { ok: false; error: string; conflict?: true; committed?: true };

type InventoryDeleteResult = { ok: true } | { ok: false; error: string; conflict?: true };

type InventoryVersionConflict = { ok: false; error: string; conflict: true };

function inventoryVersionConflict(): InventoryVersionConflict {
  return {
    ok: false,
    conflict: true,
    error: "host inventory changed since it was read; re-read and retry",
  };
}

/**
 * The version a caller read, when it has one. Routes that receive a versionless
 * request supply the freshly read version before calling this storage boundary.
 */
function expectedVersionFrom(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { version?: unknown }).version;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function prepareHostInventory(
  state: ControlPlaneState,
  hostId: string,
  body: unknown,
  options: { allowLegacyRelativeTerminalHooks?: boolean } = {},
): { ok: true; config: HostInventoryRecord } | { ok: false; error: string } {
  try {
    const parsed = parseHostBody(hostId, body, options);
    const unknownAccount = parsed.providerAccounts.find(
      (account) => !state.providerAccounts.has(account.providerAccountId),
    );
    if (unknownAccount) {
      return { ok: false, error: `unknown providerAccountId: ${unknownAccount.providerAccountId}` };
    }
    const collision = findWorktreeNameCollision(state, hostId, parsed);
    if (collision) return { ok: false, error: collision };
    const previous = state.hostInventories.get(hostId);
    const repositories = parsed.repositories.map((repository) => {
      const prior = previous?.repositories.find((item) => item.id === repository.id);
      return {
        ...repository,
        worktrees: repository.worktrees.map((worktree) => {
          const priorWorktree = prior?.worktrees.find((item) => item.id === worktree.id);
          if (!priorWorktree) return worktree;
          return {
            ...worktree,
            // Keep the daemon snapshot out of the operator-facing PUT body while
            // retaining it for the next registration comparison.
            ...(priorWorktree.daemonLabels !== undefined
              ? { daemonLabels: [...priorWorktree.daemonLabels] }
              : {}),
          };
        }),
      };
    });
    return {
      ok: true,
      config: {
        ...parsed,
        repositories,
        ...preservedDaemonRuntime(state.hostInventories.get(hostId)),
        updatedAt: state.now(),
        version: (state.hostInventories.get(hostId)?.version ?? 0) + 1,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist host configuration before changing cached inventory or derived worktrees. */
export async function putHostInventoryDurable(
  state: ControlPlaneState,
  hostId: string,
  body: unknown,
  options: {
    allowLegacyRelativeTerminalHooks?: boolean;
    /** Exec-config routes preserve their committed-result contract on projection failure. */
    awaitProjection?: boolean;
  } = {},
): Promise<InventoryWriteResult> {
  if (!state.storage) return putHostInventory(state, hostId, body, options);
  await Promise.all([listHostInventoriesDurable(state), listWorktreesDurable(state)]);
  const expectedVersion =
    expectedVersionFrom(body) ?? state.hostInventories.get(hostId)?.version ?? 0;
  const result = prepareHostInventory(state, hostId, body, options);
  if (!result.ok) return result;
  const markers = inventoryReferenceMarkers(state.now(), result.config);
  if (markers.length > 99) {
    return { ok: false, error: "host inventory has too many catalog references" };
  }
  const projection = projectHostWorktrees(state, result.config);
  const stored = await state.storage.putHostInventory(
    { ...result.config },
    markers,
    expectedVersion,
  );
  // Older storage doubles return void; only an explicit false means the conditional write lost.
  if (stored === false) return inventoryVersionConflict();
  const writeProjection = async (storage: DynamoPlaneStorage | undefined): Promise<void> => {
    await Promise.all([
      ...projection.worktrees.map((worktree) => storage!.putWorktree({ ...worktree })),
      ...projection.removedIds.map((id) => storage!.deleteWorktree(id)),
    ]);
  };
  state.hostInventoryRevision += 1;
  state.hostInventories.set(hostId, result.config);
  for (const worktree of projection.worktrees) state.worktrees.set(worktree.id, worktree);
  for (const id of projection.removedIds) state.worktrees.delete(id);
  if (options.awaitProjection === false) {
    // The inventory document is already committed. Exec-config callers intentionally retain
    // their committed-result response contract while the ordinary inventory route below waits.
    queueWrite(state, writeProjection);
  } else {
    // Do not acknowledge an ordinary inventory update while its derived worktree catalog is
    // merely queued. A direct attempt avoids leaving a failed promise in the general queue;
    // if it fails, enqueue one durable retry so a transient projection outage is repaired.
    await state.writeTail.catch(() => undefined);
    let projectionError: unknown;
    try {
      await writeProjection(state.storage);
    } catch (error) {
      projectionError = error;
      try {
        await queueWrite(state, writeProjection);
        projectionError = undefined;
      } catch (retryError) {
        projectionError = retryError;
      }
    }
    if (projectionError !== undefined) {
      return {
        ok: false,
        committed: true,
        error: `host inventory committed but worktree projection failed: ${
          projectionError instanceof Error ? projectionError.message : String(projectionError)
        }`,
      };
    }
  }
  return { ok: true, config: withoutDaemonLabelProvenance(result.config) };
}

export function getHostInventory(
  state: ControlPlaneState,
  hostId: string,
): HostInventoryRecord | null {
  const rec = state.hostInventories.get(hostId);
  return rec ? withoutDaemonLabelProvenance(rec) : null;
}

export function listHostInventories(state: ControlPlaneState): HostInventoryRecord[] {
  return [...state.hostInventories.values()]
    .toSorted((a, b) => a.hostId.localeCompare(b.hostId))
    .map((h) => withoutDaemonLabelProvenance(h));
}

export function deleteHostInventory(
  state: ControlPlaneState,
  hostId: string,
  expectedVersion?: number,
): InventoryDeleteResult {
  const existing = state.hostInventories.get(hostId);
  if (!existing) {
    return { ok: false, error: "agent host config not found" };
  }
  const expected = expectedVersion ?? existing.version ?? 0;
  if ((existing.version ?? 0) !== expected) return inventoryVersionConflict();
  state.hostInventories.delete(hostId);
  state.hostInventoryRevision += 1;
  if (state.storage) {
    queueWrite(state, (storage) => storage!.deleteHostInventory(hostId, expected));
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
  expectedVersion?: number,
): Promise<InventoryDeleteResult> {
  if (!state.storage) return deleteHostInventory(state, hostId, expectedVersion);
  const existing = await getHostInventoryDurable(state, hostId);
  if (!existing) {
    return { ok: false, error: "agent host config not found" };
  }
  const expected = expectedVersion ?? existing.version ?? 0;
  await listWorktreesDurable(state);
  const worktreeIds = [...state.worktrees.values()]
    .filter((worktree) => worktree.hostId === hostId)
    .map((worktree) => worktree.id);
  const deleted = await state.storage.deleteHostInventory(hostId, expected);
  if (deleted === false) return inventoryVersionConflict();
  await Promise.all(worktreeIds.map((id) => state.storage!.deleteWorktree(id)));
  state.hostInventoryRevision += 1;
  state.hostInventories.delete(hostId);
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === hostId) state.worktrees.delete(id);
  }
  return { ok: true };
}
