/* eslint-disable max-lines -- durable inventory projections and version-fenced mutations share one state boundary. */
import { posix, win32 } from "node:path";

import { thrownMessage } from "@auto-harness/shared";
import type { DynamoPlaneStorage, HostInventoryRecord } from "./db/plane-storage.ts";
import type { WorkspaceSlotRecord, WorktreeRecord } from "./db/types.ts";
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
  listProviderAccountsDurable,
} from "./control-plane-durable-read-catalog.ts";
import { listWorkspacePoolsDurable } from "./control-plane-workspace-pools.ts";
import {
  listWorkspaceSlotsDurable,
  listWorktreesDurable,
} from "./control-plane-durable-read-runtime.ts";
import { inventoryReferenceMarkers } from "./control-plane-delete-reference-markers.ts";

async function persistRetiredWorkspaceSlot(
  storage: DynamoPlaneStorage,
  slot: WorkspaceSlotRecord,
): Promise<WorkspaceSlotRecord | null> {
  if (!slot.currentSessionId || typeof storage.retireWorkspaceSlot !== "function") {
    await storage.putWorkspaceSlot({ ...slot });
    return slot;
  }
  if (await storage.retireWorkspaceSlot(slot.id, slot.currentSessionId)) return slot;

  // The terminal transition (or a second scheduler) won between projection
  // and the retire fence. Re-read: an idle row can disappear now; a newly
  // claimed row becomes the tombstone's new owner instead of returning to
  // capacity under a removed inventory attachment.
  let current =
    typeof storage.getWorkspaceSlot === "function" ? await storage.getWorkspaceSlot(slot.id) : null;
  // A racing terminal/reassignment may change ownership between each read and
  // conditional mutation. Never synthesize `retired` locally: either fence a
  // real current owner, delete a released row, or fail so the queued durable
  // projection retry observes a fresh state.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!current) return null;
    if (current.currentSessionId && typeof storage.retireWorkspaceSlot === "function") {
      if (await storage.retireWorkspaceSlot(current.id, current.currentSessionId)) {
        return { ...current, online: false, retired: true };
      }
    } else if (
      !current.currentSessionId &&
      typeof storage.deleteWorkspaceSlotIfIdle === "function" &&
      (await storage.deleteWorkspaceSlotIfIdle(current.id))
    ) {
      return null;
    }
    current =
      typeof storage.getWorkspaceSlot === "function"
        ? await storage.getWorkspaceSlot(slot.id)
        : null;
  }
  throw new Error("workspace slot changed repeatedly while retiring it from inventory");
}

function syncWorktreesFromHost(state: ControlPlaneState, host: HostInventoryRecord): void {
  const { worktrees, removedIds } = projectHostWorktrees(state, host);
  for (const worktree of worktrees) {
    persistWorktree(state, worktree);
  }
  for (const id of removedIds) state.worktrees.delete(id);
}

function projectHostWorkspaceSlots(
  state: ControlPlaneState,
  host: HostInventoryRecord,
  options: {
    advertisedWorkspacePools?: readonly import("@auto-harness/shared").WorkspacePoolAttachment[];
  } = {},
): { slots: WorkspaceSlotRecord[]; retiredSlots: WorkspaceSlotRecord[]; removedIds: string[] } {
  const online = state.hostConnection.has(host.hostId);
  const configuredIds = new Set<string>();
  const slots: WorkspaceSlotRecord[] = [];
  for (const attachment of host.workspacePools ?? []) {
    for (const slot of attachment.slots) {
      configuredIds.add(slot.id);
      const previous = state.workspaceSlots.get(slot.id);
      const unchanged =
        previous?.hostId === host.hostId &&
        previous.workspacePoolId === attachment.workspacePoolId &&
        previous.path === slot.path;
      const daemonAcknowledged = options.advertisedWorkspacePools?.some(
        (advertisedPool) =>
          advertisedPool.workspacePoolId === attachment.workspacePoolId &&
          advertisedPool.slots.some(
            (advertisedSlot) =>
              advertisedSlot.id === slot.id &&
              advertisedSlot.name === slot.name &&
              advertisedSlot.path === slot.path,
          ),
      );
      const connectionId = daemonAcknowledged
        ? state.hostConnection.get(host.hostId)
        : options.advertisedWorkspacePools
          ? undefined
          : unchanged
            ? previous.connectionId
            : undefined;
      slots.push({
        id: slot.id,
        name: slot.name,
        path: slot.path,
        hostId: host.hostId,
        workspacePoolId: attachment.workspacePoolId,
        status:
          previous?.status === "busy" || previous?.status === "error" ? previous.status : "idle",
        online: options.advertisedWorkspacePools
          ? Boolean(daemonAcknowledged && online)
          : unchanged
            ? previous.online
            : false,
        currentSessionId: previous?.currentSessionId ?? null,
        lastAssignedAt: previous?.lastAssignedAt ?? null,
        ...(connectionId ? { connectionId } : {}),
        ...(previous?.errorMessage ? { errorMessage: previous.errorMessage } : {}),
      });
    }
  }
  const removedIds = [...state.workspaceSlots.values()]
    .filter(
      (slot) =>
        slot.hostId === host.hostId && !configuredIds.has(slot.id) && slot.status !== "busy",
    )
    .map((slot) => slot.id);
  // Do not erase an active allocation merely because the next inventory
  // snapshot no longer advertises it. The terminal transition must not turn
  // that path into a new candidate; retain an offline tombstone until its
  // exact owner releases it.
  const retiredSlots = [...state.workspaceSlots.values()]
    .filter(
      (slot) =>
        slot.hostId === host.hostId &&
        !configuredIds.has(slot.id) &&
        (slot.status === "busy" || slot.currentSessionId != null),
    )
    .map((slot) => ({ ...slot, online: false, retired: true }));
  return { slots, retiredSlots, removedIds };
}

/** Project a locally accepted inventory snapshot into its workspace-slot read model. */
export function syncHostWorkspaceSlots(
  state: ControlPlaneState,
  host: HostInventoryRecord,
  advertisedWorkspacePools?:
    | readonly import("@auto-harness/shared").WorkspacePoolAttachment[]
    | null,
): void {
  const advertised = advertisedWorkspacePools ?? host.workspacePools ?? [];
  const projection = projectHostWorkspaceSlots(
    state,
    host,
    advertisedWorkspacePools === null ? {} : { advertisedWorkspacePools: advertised },
  );
  for (const slot of projection.slots) {
    state.workspaceSlots.set(slot.id, slot);
    if (state.storage) queueWrite(state, (storage) => storage!.putWorkspaceSlot({ ...slot }));
  }
  for (const slot of projection.retiredSlots) {
    state.workspaceSlots.set(slot.id, slot);
    if (state.storage)
      queueWrite(state, async (storage) => {
        const result = await persistRetiredWorkspaceSlot(storage!, slot);
        if (result) state.workspaceSlots.set(result.id, result);
        else state.workspaceSlots.delete(slot.id);
      });
  }
  for (const id of projection.removedIds) {
    state.workspaceSlots.delete(id);
    if (state.storage) queueWrite(state, (storage) => storage!.deleteWorkspaceSlot(id));
  }
}

/** Persist a durable registration's workspace-slot projection before acknowledging it. */
export async function syncHostWorkspaceSlotsDurable(
  state: ControlPlaneState,
  host: HostInventoryRecord,
  advertisedWorkspacePools?:
    | readonly import("@auto-harness/shared").WorkspacePoolAttachment[]
    | null,
): Promise<void> {
  const advertised = advertisedWorkspacePools ?? host.workspacePools ?? [];
  if (!state.storage) return syncHostWorkspaceSlots(state, host, advertisedWorkspacePools);
  const projection = projectHostWorkspaceSlots(
    state,
    host,
    advertisedWorkspacePools === null ? {} : { advertisedWorkspacePools: advertised },
  );
  const retired = await Promise.all(
    projection.retiredSlots.map((slot) => persistRetiredWorkspaceSlot(state.storage!, slot)),
  );
  await Promise.all([
    ...projection.slots.map(async (slot) => {
      if (slot.status === "busy" && !slot.retired) return;
      const connectionId = state.hostConnection.get(host.hostId);
      if (connectionId && typeof state.storage!.putWorkspaceSlotFenced === "function") {
        const expectedConnectionId = state.workspaceSlots.get(slot.id)?.connectionId;
        if (
          !(await state.storage!.putWorkspaceSlotFenced(
            { ...slot },
            connectionId,
            expectedConnectionId,
          ))
        ) {
          throw new Error("host connection changed while publishing workspace slots");
        }
      } else {
        await state.storage!.putWorkspaceSlot({ ...slot });
      }
    }),
    ...projection.removedIds.map(async (id) => await state.storage!.deleteWorkspaceSlot(id)),
  ]);
  for (const slot of projection.slots) state.workspaceSlots.set(slot.id, slot);
  for (const [index, slot] of retired.entries()) {
    if (slot) state.workspaceSlots.set(slot.id, slot);
    else state.workspaceSlots.delete(projection.retiredSlots[index]!.id);
  }
  for (const id of projection.removedIds) state.workspaceSlots.delete(id);
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
  syncHostWorkspaceSlots(state, rec, null);
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
 * Compare paths using the spelling rules of the host platform they advertise.
 * The control plane cannot resolve a host's symlinks, but it can still fence
 * lexical aliases before replacing a leased slot identity. Windows paths are
 * case-insensitive; POSIX paths are intentionally case-sensitive here.
 */
function workspacePathAliasKey(path: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\");
  const normalized = windowsPath ? win32.normalize(path) : posix.normalize(path);
  const root = windowsPath ? /^[A-Za-z]:[\\/]$/.test(normalized) : normalized === "/";
  const trimmed = root ? normalized : normalized.replace(/[\\/]+$/, "");
  return windowsPath ? trimmed.toLowerCase() : trimmed;
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
    for (const attachment of parsed.workspacePools ?? []) {
      if (!state.workspacePools.has(attachment.workspacePoolId)) {
        return { ok: false, error: `unknown workspacePoolId: ${attachment.workspacePoolId}` };
      }
      for (const slot of attachment.slots) {
        const projected = state.workspaceSlots.get(slot.id);
        if (projected && projected.hostId !== hostId) {
          return { ok: false, error: `workspace slot id already in use: ${slot.id}` };
        }
        if (
          (projected?.status === "busy" || projected?.currentSessionId) &&
          (projected.path !== slot.path || projected.workspacePoolId !== attachment.workspacePoolId)
        ) {
          return {
            ok: false,
            error: `cannot change the path or pool of busy workspace slot: ${slot.id}`,
          };
        }
        const leasedPath = [...state.workspaceSlots.values()].find(
          (candidate) =>
            candidate.hostId === hostId &&
            candidate.id !== slot.id &&
            workspacePathAliasKey(candidate.path) === workspacePathAliasKey(slot.path) &&
            (candidate.status === "busy" || candidate.currentSessionId != null),
        );
        if (leasedPath) {
          return {
            ok: false,
            error: `cannot replace the id of busy workspace slot: ${leasedPath.id}`,
          };
        }
      }
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
    return { ok: false, error: thrownMessage(err) };
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
  await Promise.all([
    listHostInventoriesDurable(state),
    listWorktreesDurable(state),
    typeof state.storage.listWorkspaceSlots === "function"
      ? listWorkspaceSlotsDurable(state)
      : Promise.resolve(),
    typeof state.storage.listProviderAccounts === "function"
      ? listProviderAccountsDurable(state)
      : Promise.resolve(),
    typeof state.storage.listWorkspacePools === "function"
      ? listWorkspacePoolsDurable(state)
      : Promise.resolve(),
  ]);
  const expectedVersion =
    expectedVersionFrom(body) ?? state.hostInventories.get(hostId)?.version ?? 0;
  const result = prepareHostInventory(state, hostId, body, options);
  if (!result.ok) return result;
  const markers = inventoryReferenceMarkers(state.now(), result.config);
  if (markers.length > 99) {
    return { ok: false, error: "host inventory has too many catalog references" };
  }
  const projection = projectHostWorktrees(state, result.config);
  const workspaceProjection = projectHostWorkspaceSlots(state, result.config);
  const stored = await state.storage.putHostInventory(
    { ...result.config },
    markers,
    expectedVersion,
  );
  // Older storage doubles return void; only an explicit false means the conditional write lost.
  if (stored === false) return inventoryVersionConflict();
  const writeProjection = async (storage: DynamoPlaneStorage | undefined): Promise<void> => {
    const writeSlot = async (slot: WorkspaceSlotRecord): Promise<void> => {
      if (slot.status === "busy" && !slot.retired) return;
      const connectionId = slot.connectionId;
      if (connectionId && typeof storage!.putWorkspaceSlotFenced === "function") {
        const expectedConnectionId = state.workspaceSlots.get(slot.id)?.connectionId;
        if (
          !(await storage!.putWorkspaceSlotFenced({ ...slot }, connectionId, expectedConnectionId))
        ) {
          throw new Error("host connection changed while publishing workspace slots");
        }
        return;
      }
      await storage!.putWorkspaceSlot({ ...slot });
    };
    await Promise.all([
      ...projection.worktrees.map((worktree) => storage!.putWorktree({ ...worktree })),
      ...projection.removedIds.map((id) => storage!.deleteWorktree(id)),
      ...workspaceProjection.slots.map((slot) => writeSlot(slot)),
      ...workspaceProjection.retiredSlots.map(async (slot) => {
        const retired = await persistRetiredWorkspaceSlot(storage!, slot);
        if (retired) state.workspaceSlots.set(retired.id, retired);
        else state.workspaceSlots.delete(slot.id);
      }),
      ...workspaceProjection.removedIds.map((id) => storage!.deleteWorkspaceSlot(id)),
    ]);
  };
  state.hostInventoryRevision += 1;
  state.hostInventories.set(hostId, result.config);
  for (const worktree of projection.worktrees) state.worktrees.set(worktree.id, worktree);
  for (const id of projection.removedIds) state.worktrees.delete(id);
  for (const slot of workspaceProjection.slots) state.workspaceSlots.set(slot.id, slot);
  for (const slot of workspaceProjection.retiredSlots) state.workspaceSlots.set(slot.id, slot);
  for (const id of workspaceProjection.removedIds) state.workspaceSlots.delete(id);
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
        error: `host inventory committed but worktree projection failed: ${thrownMessage(
          projectionError,
        )}`,
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
  if (
    [...state.workspaceSlots.values()].some(
      (slot) => slot.hostId === hostId && (slot.status === "busy" || slot.currentSessionId != null),
    )
  ) {
    return { ok: false, error: "host has active workspace slots" };
  }
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
  for (const [id, slot] of state.workspaceSlots) {
    if (slot.hostId === hostId) state.workspaceSlots.delete(id);
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
  if (typeof state.storage.listWorkspaceSlots === "function") {
    await listWorkspaceSlotsDurable(state);
  }
  if (
    [...state.workspaceSlots.values()].some(
      (slot) => slot.hostId === hostId && (slot.status === "busy" || slot.currentSessionId != null),
    )
  ) {
    return { ok: false, error: "host has active workspace slots" };
  }
  await listWorktreesDurable(state);
  const worktreeIds = [...state.worktrees.values()]
    .filter((worktree) => worktree.hostId === hostId)
    .map((worktree) => worktree.id);
  const workspaceSlotIds = [...state.workspaceSlots.values()]
    .filter((slot) => slot.hostId === hostId)
    .map((slot) => slot.id);
  const deleted = await state.storage.deleteHostInventory(hostId, expected);
  if (deleted === false) return inventoryVersionConflict();
  const deleteSlot = (id: string): Promise<unknown> =>
    typeof state.storage!.deleteWorkspaceSlotIfIdle === "function"
      ? state.storage!.deleteWorkspaceSlotIfIdle(id)
      : state.storage!.deleteWorkspaceSlot(id);
  const slotDeletes = await Promise.all(
    workspaceSlotIds.map(async (id) => ({ id, slotDeleted: await deleteSlot(id) })),
  );
  const deletedSlotIds = new Set(
    slotDeletes.filter(({ slotDeleted }) => slotDeleted !== false).map(({ id }) => id),
  );
  await Promise.all(worktreeIds.map((id) => state.storage!.deleteWorktree(id)));
  state.hostInventoryRevision += 1;
  state.hostInventories.delete(hostId);
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === hostId) state.worktrees.delete(id);
  }
  for (const [id, slot] of state.workspaceSlots) {
    if (slot.hostId !== hostId) continue;
    if (deletedSlotIds.has(id)) {
      state.workspaceSlots.delete(id);
    } else if (typeof state.storage.getWorkspaceSlot === "function") {
      const latest = await state.storage.getWorkspaceSlot(id);
      if (latest) state.workspaceSlots.set(id, { ...latest, online: false });
    }
  }
  return { ok: true };
}
