import { isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

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
    createdAt: at,
    updatedAt: at,
    ...(input.setupScript !== undefined ? { setupScript: input.setupScript } : {}),
    ...(input.terminalHookScript !== undefined
      ? { terminalHookScript: input.terminalHookScript }
      : {}),
  };
  state.repositories.set(id, rec);
  if (state.storage) {
    queueWrite(state, state.storage.putRepository({ ...rec }));
  }
  return { ok: true, repository: { ...rec } };
}

export function getRepository(state: ControlPlaneState, id: string): RepositoryRecord | null {
  const r = state.repositories.get(id);
  return r ? { ...r } : null;
}

export function listRepositories(state: ControlPlaneState): RepositoryRecord[] {
  return [...state.repositories.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((r) => ({ ...r }));
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
  state.repositories.set(id, next);
  if (state.storage) {
    queueWrite(state, state.storage.putRepository({ ...next }));
  }
  return { ok: true, repository: { ...next } };
}

export function deleteRepository(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.repositories.has(id)) {
    return { ok: false, error: "repository not found" };
  }
  state.repositories.delete(id);
  if (state.storage) {
    queueWrite(state, state.storage.deleteRepository(id));
  }
  return { ok: true };
}
