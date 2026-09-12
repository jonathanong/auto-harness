/* eslint-disable max-lines -- pool validation, redaction, persistence, and fenced deletion share one catalog boundary. */
import { isActiveSessionStatus, isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import type { WorkspacePoolRecord, WorkspaceSetupProfile } from "./db/plane-storage.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";
import { refreshDeleteReferences } from "./control-plane-delete-guards.ts";

const MAX_SETUP_PROFILES = 32;
const MAX_SETUP_SCRIPT_LENGTH = 65_536;
const MAX_SETUP_PROFILES_BYTES = 320 * 1_024;

export type WorkspacePoolInput = {
  id?: string;
  name: string;
  setupProfiles?: WorkspaceSetupProfile[];
  defaultSetupProfileId?: string | null;
  destroyWorkspaceAfter?: boolean;
};

export type PublicWorkspacePool = Omit<WorkspacePoolRecord, "setupProfiles"> & {
  setupProfiles: Array<Pick<WorkspaceSetupProfile, "id" | "name">>;
};

function publicPool(pool: WorkspacePoolRecord): PublicWorkspacePool {
  return {
    ...pool,
    setupProfiles: pool.setupProfiles.map(({ id, name }) => ({ id, name })),
  };
}

function validateProfiles(
  profiles: readonly WorkspaceSetupProfile[],
  defaultId: string | null | undefined,
): string | null {
  if (profiles.length > MAX_SETUP_PROFILES) {
    return `a workspace pool supports at most ${MAX_SETUP_PROFILES} setup profiles`;
  }
  if (Buffer.byteLength(JSON.stringify(profiles), "utf8") > MAX_SETUP_PROFILES_BYTES) {
    return "workspace pool setup profiles are too large";
  }
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!isValidSlugName(profile.id)) return `setup profile id must be ${SLUG_NAME_HINT}`;
    if (!profile.name.trim()) return `setup profile name is required: ${profile.id}`;
    if (ids.has(profile.id)) return "setup profile ids must be unique";
    ids.add(profile.id);
    if (!profile.script.trim()) return `setup profile script is required: ${profile.id}`;
    if (Buffer.byteLength(profile.script, "utf8") > MAX_SETUP_SCRIPT_LENGTH) {
      return `setup profile script is too long: ${profile.id}`;
    }
  }
  if (defaultId && !ids.has(defaultId)) {
    return `default setup profile does not exist: ${defaultId}`;
  }
  return null;
}

function prepareWorkspacePool(
  state: ControlPlaneState,
  input: WorkspacePoolInput,
  existing?: WorkspacePoolRecord,
): { ok: true; workspacePool: WorkspacePoolRecord } | { ok: false; error: string } {
  if (!isValidSlugName(input.name)) return { ok: false, error: `name must be ${SLUG_NAME_HINT}` };
  const collision = [...state.workspacePools.values()].find(
    (pool) => pool.name === input.name && pool.id !== existing?.id,
  );
  if (collision) return { ok: false, error: `workspace pool name already in use: ${input.name}` };
  const profiles = (input.setupProfiles ?? existing?.setupProfiles ?? []).map((profile) => ({
    ...profile,
  }));
  const defaultId =
    input.defaultSetupProfileId === null
      ? undefined
      : (input.defaultSetupProfileId ?? existing?.defaultSetupProfileId);
  const profileError = validateProfiles(profiles, defaultId);
  if (profileError) return { ok: false, error: profileError };
  const now = state.now();
  return {
    ok: true,
    workspacePool: {
      id: existing?.id ?? input.id ?? state.workspacePoolIdFactory(),
      name: input.name,
      setupProfiles: profiles,
      ...(defaultId ? { defaultSetupProfileId: defaultId } : {}),
      destroyWorkspaceAfter:
        input.destroyWorkspaceAfter ?? existing?.destroyWorkspaceAfter ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  };
}

export function createWorkspacePool(state: ControlPlaneState, input: WorkspacePoolInput) {
  const prepared = prepareWorkspacePool(state, input);
  if (!prepared.ok) return prepared;
  if (state.workspacePools.has(prepared.workspacePool.id)) {
    return {
      ok: false as const,
      error: `workspace pool already exists: ${prepared.workspacePool.id}`,
    };
  }
  state.workspacePools.set(prepared.workspacePool.id, prepared.workspacePool);
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putWorkspacePool(prepared.workspacePool));
  }
  return { ok: true as const, workspacePool: { ...prepared.workspacePool } };
}

export async function createWorkspacePoolDurable(
  state: ControlPlaneState,
  input: WorkspacePoolInput,
): Promise<ReturnType<typeof createWorkspacePool>> {
  if (!state.storage) return createWorkspacePool(state, input);
  await listWorkspacePoolsDurable(state);
  const prepared = prepareWorkspacePool(state, input);
  if (!prepared.ok) return prepared;
  if (!(await state.storage.createWorkspacePool(prepared.workspacePool))) {
    return { ok: false, error: "workspace pool already exists" };
  }
  state.workspacePools.set(prepared.workspacePool.id, prepared.workspacePool);
  return { ok: true, workspacePool: { ...prepared.workspacePool } };
}

export function listWorkspacePools(state: ControlPlaneState): WorkspacePoolRecord[] {
  return [...state.workspacePools.values()]
    .map((pool) => ({
      ...pool,
      setupProfiles: pool.setupProfiles.map((profile) => ({ ...profile })),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function listWorkspacePoolsPublic(state: ControlPlaneState): PublicWorkspacePool[] {
  return listWorkspacePools(state).map(publicPool);
}

export async function listWorkspacePoolsDurable(state: ControlPlaneState) {
  if (!state.storage || typeof state.storage.listWorkspacePools !== "function") {
    return listWorkspacePools(state);
  }
  const records = await state.storage.listWorkspacePools();
  state.workspacePools.clear();
  for (const record of records) state.workspacePools.set(record.id, record);
  return listWorkspacePools(state);
}

export async function getWorkspacePoolDurable(state: ControlPlaneState, id: string) {
  if (!state.storage) return state.workspacePools.get(id) ?? null;
  const record = await state.storage.getWorkspacePool(id);
  if (record) state.workspacePools.set(id, record);
  else state.workspacePools.delete(id);
  return record;
}

export function updateWorkspacePool(
  state: ControlPlaneState,
  id: string,
  patch: Partial<Omit<WorkspacePoolInput, "id">>,
) {
  const existing = state.workspacePools.get(id);
  if (!existing) return { ok: false as const, error: "workspace pool not found" };
  const prepared = prepareWorkspacePool(state, { ...existing, ...patch }, existing);
  if (!prepared.ok) return prepared;
  state.workspacePools.set(id, prepared.workspacePool);
  if (state.storage)
    queueWrite(state, (storage) => storage!.putWorkspacePool(prepared.workspacePool));
  return { ok: true as const, workspacePool: { ...prepared.workspacePool } };
}

export async function updateWorkspacePoolDurable(
  state: ControlPlaneState,
  id: string,
  patch: Partial<Omit<WorkspacePoolInput, "id">>,
) {
  if (!state.storage) return updateWorkspacePool(state, id, patch);
  await listWorkspacePoolsDurable(state);
  const existing = state.workspacePools.get(id);
  if (!existing) return { ok: false as const, error: "workspace pool not found" };
  const prepared = prepareWorkspacePool(state, { ...existing, ...patch }, existing);
  if (!prepared.ok) return prepared;
  return withDeletionMarkers(state, [`workspace-pool:${id}`], async () => {
    const updated =
      typeof state.storage!.updateWorkspacePool === "function"
        ? await state.storage!.updateWorkspacePool(prepared.workspacePool)
        : (await state.storage!.putWorkspacePool(prepared.workspacePool), true);
    if (!updated) return { ok: false as const, error: "workspace pool not found" };
    state.workspacePools.set(id, prepared.workspacePool);
    return { ok: true as const, workspacePool: { ...prepared.workspacePool } };
  });
}

function poolDependency(
  state: ControlPlaneState,
  id: string,
  refs?: Awaited<ReturnType<typeof refreshDeleteReferences>>,
): string | null {
  if (
    refs
      ? refs.inventories.some((inventory) =>
          inventory.workspacePools?.some((attachment) => attachment.workspacePoolId === id),
        )
      : [...state.workspaceSlots.values()].some((slot) => slot.workspacePoolId === id)
  ) {
    return "workspace pool is attached to a host";
  }
  if ((refs?.schedules ?? [...state.schedules.values()]).some((s) => s.workspacePoolId === id)) {
    return "workspace pool is referenced by a schedule";
  }
  if (
    (refs?.sessions ?? [...state.sessions.values()]).some(
      (session) => session.workspacePoolId === id && isActiveSessionStatus(session.status),
    )
  ) {
    return "workspace pool has queued or running sessions";
  }
  return null;
}

export async function deleteWorkspacePoolDurable(state: ControlPlaneState, id: string) {
  if (state.storage) await listWorkspacePoolsDurable(state);
  if (!state.workspacePools.has(id))
    return { ok: false as const, error: "workspace pool not found" };
  if (!state.storage) {
    const dependency = poolDependency(state, id);
    if (dependency) return { ok: false as const, error: dependency };
    state.workspacePools.delete(id);
    return { ok: true as const };
  }
  return withDeletionMarkers(state, [`workspace-pool:${id}`], async (owner) => {
    const dependency = poolDependency(state, id, await refreshDeleteReferences(state));
    if (dependency) return { ok: false as const, error: dependency };
    await state.storage!.deleteWorkspacePool(id, [
      { key: `workspace-pool:${id}`, owner, now: state.now() },
    ]);
    state.workspacePools.delete(id);
    return { ok: true as const };
  });
}
