import { isValidSlugName, repositoryAdmissionState, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { listRepositoriesDurable } from "./control-plane-durable-read-catalog.ts";

function findRepositoryByName(
  state: ControlPlaneState,
  name: string,
  excludeId?: string,
): RepositoryRecord | undefined {
  for (const r of state.repositories.values()) {
    if (r.name === name && r.id !== excludeId) {
      return r;
    }
  }
  return undefined;
}

export { deleteRepository, deleteRepositoryDurable } from "./control-plane-repository-delete.ts";

export function createRepository(
  state: ControlPlaneState,
  input: {
    id?: string;
    name: string;
    url: string;
    defaultBranch?: string;
    setupScript?: string;
    terminalHookScript?: string;
  },
): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
  const result = prepareCreateRepository(state, input);
  if (!result.ok) return result;
  state.repositories.set(result.repository.id, result.repository);
  state.repositoryRevision += 1;
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putRepository({ ...result.repository }));
  }
  return { ok: true, repository: { ...result.repository } };
}

function prepareCreateRepository(
  state: ControlPlaneState,
  input: {
    id?: string;
    name: string;
    url: string;
    defaultBranch?: string;
    setupScript?: string;
    terminalHookScript?: string;
  },
): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
  if (!input.name || !input.url) {
    return { ok: false, error: "name and url are required" };
  }
  if (!isValidSlugName(input.name)) {
    return { ok: false, error: `name must be ${SLUG_NAME_HINT}` };
  }
  if (findRepositoryByName(state, input.name)) {
    return { ok: false, error: `repository name already in use: ${input.name}` };
  }
  const id = input.id ?? state.repositoryIdFactory();
  if (state.repositories.has(id)) {
    return { ok: false, error: `repository already exists: ${id}` };
  }
  const at = state.now();
  const rec: RepositoryRecord = {
    id,
    name: input.name,
    url: input.url,
    defaultBranch: input.defaultBranch ?? "main",
    admissionState: "active",
    admissionStateChangedAt: at,
    createdAt: at,
    updatedAt: at,
    ...(input.setupScript !== undefined ? { setupScript: input.setupScript } : {}),
    ...(input.terminalHookScript !== undefined
      ? { terminalHookScript: input.terminalHookScript }
      : {}),
  };
  return { ok: true, repository: rec };
}

/** Persist a repository before exposing it through the process cache. */
export async function createRepositoryDurable(
  state: ControlPlaneState,
  input: Parameters<typeof createRepository>[1],
): Promise<ReturnType<typeof createRepository>> {
  if (!state.storage) return createRepository(state, input);
  await listRepositoriesDurable(state);
  const result = prepareCreateRepository(state, input);
  if (!result.ok) return result;
  // Keep durable callers compatible with storage adapters from before
  // conditional repository creation was introduced. Production Dynamo storage
  // always takes the conditional path below.
  if (!state.storage.createRepository) {
    await state.storage.putRepository({ ...result.repository });
    state.repositories.set(result.repository.id, result.repository);
    state.repositoryRevision += 1;
    return { ok: true, repository: { ...result.repository } };
  }
  const created = await state.storage.createRepository({ ...result.repository });
  if (!created) {
    const authoritative = await state.storage.getRepository(result.repository.id);
    if (authoritative) {
      state.repositories.set(authoritative.id, authoritative);
      state.repositoryRevision += 1;
    }
    return { ok: false, error: "repository already exists" };
  }
  state.repositories.set(result.repository.id, result.repository);
  state.repositoryRevision += 1;
  return { ok: true, repository: { ...result.repository } };
}

export function getRepository(state: ControlPlaneState, id: string): RepositoryRecord | null {
  const r = state.repositories.get(id);
  return r ? { ...r, admissionState: repositoryAdmissionState(r.admissionState) } : null;
}

export function listRepositories(state: ControlPlaneState): RepositoryRecord[] {
  return [...state.repositories.values()].toSorted(compareRepositories).flatMap((r) => {
    try {
      return [{ ...r, admissionState: repositoryAdmissionState(r.admissionState) }];
    } catch {
      // A malformed persisted row must not hide healthy repositories from the catalog.
      // Omit the invalid row until an operator repairs it; admission checks still fail closed.
      return [];
    }
  });
}

export function compareRepositories(a: RepositoryRecord, b: RepositoryRecord): number {
  // Repository names are validated ASCII slugs and generated IDs are ASCII.
  // Keep this bytewise order aligned with Dynamo's catalogSort GSI key.
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function updateRepository(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{
    name: string;
    url: string;
    defaultBranch: string;
    setupScript: string;
    terminalHookScript: string;
  }>,
): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
  const result = prepareUpdateRepository(state, id, patch);
  if (!result.ok) return result;
  state.repositories.set(id, result.repository);
  state.repositoryRevision += 1;
  if (state.storage) {
    queueWrite(state, async (storage) => {
      await storage!.updateRepositorySettings(id, patch, result.repository.updatedAt);
    });
  }
  return { ok: true, repository: { ...result.repository } };
}

function prepareUpdateRepository(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{
    name: string;
    url: string;
    defaultBranch: string;
    setupScript: string;
    terminalHookScript: string;
  }>,
): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
  const existing = state.repositories.get(id);
  if (!existing) {
    return { ok: false, error: "repository not found" };
  }
  if (patch.name !== undefined) {
    if (!isValidSlugName(patch.name)) {
      return { ok: false, error: `name must be ${SLUG_NAME_HINT}` };
    }
    if (findRepositoryByName(state, patch.name, id)) {
      return { ok: false, error: `repository name already in use: ${patch.name}` };
    }
  }
  const next: RepositoryRecord = {
    ...existing,
    updatedAt: state.now(),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.defaultBranch !== undefined ? { defaultBranch: patch.defaultBranch } : {}),
    ...(patch.setupScript !== undefined ? { setupScript: patch.setupScript } : {}),
    ...(patch.terminalHookScript !== undefined
      ? { terminalHookScript: patch.terminalHookScript }
      : {}),
  };
  return { ok: true, repository: next };
}

/** Persist an update before replacing the cached repository. */
export async function updateRepositoryDurable(
  state: ControlPlaneState,
  id: string,
  patch: Parameters<typeof updateRepository>[2],
): Promise<ReturnType<typeof updateRepository>> {
  if (!state.storage) return updateRepository(state, id, patch);
  await listRepositoriesDurable(state);
  const result = prepareUpdateRepository(state, id, patch);
  if (!result.ok) return result;
  const updated = await state.storage.updateRepositorySettings(
    id,
    patch,
    result.repository.updatedAt,
  );
  if (!updated) return { ok: false, error: "repository not found" };
  state.repositories.set(id, updated);
  state.repositoryRevision += 1;
  return { ok: true, repository: { ...updated } };
}
