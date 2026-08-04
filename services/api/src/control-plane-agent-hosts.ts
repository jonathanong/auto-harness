import { isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { AgentHostRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { findWorktreeNameCollision } from "./control-plane-worktree-names.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ctx}: ${key} must be a non-empty string`);
  }
  return value;
}

function parseHostBody(agentId: string, body: unknown): Omit<AgentHostRecord, "updatedAt"> {
  if (!isRecord(body)) {
    throw new Error("body must be an object");
  }
  if (body.agentId !== undefined && body.agentId !== agentId) {
    throw new Error("body.agentId must match path agentId");
  }
  // Empty repositories allowed: register agent / seed host before attaching repos.
  if (!Array.isArray(body.repositories)) {
    throw new Error("repositories must be an array");
  }
  const repositories: AgentHostRecord["repositories"] = [];
  for (const [ri, rawRepo] of body.repositories.entries()) {
    if (!isRecord(rawRepo)) {
      throw new Error(`repositories[${ri}] must be an object`);
    }
    const id = requireString(rawRepo, "id", `repositories[${ri}]`);
    const path = requireString(rawRepo, "path", `repository.${id}`);
    const defaultBranch =
      typeof rawRepo.defaultBranch === "string" && rawRepo.defaultBranch.length > 0
        ? rawRepo.defaultBranch
        : "main";
    if (!Array.isArray(rawRepo.worktrees)) {
      throw new Error(`repository.${id}.worktrees must be an array`);
    }
    const worktrees = rawRepo.worktrees.map((rawWt, wi) => {
      if (!isRecord(rawWt)) {
        throw new Error(`repositories.${id}.worktrees[${wi}] invalid`);
      }
      const wtId = requireString(rawWt, "id", `worktree[${wi}]`);
      const wtName = requireString(rawWt, "name", `worktree.${wtId}`);
      if (!isValidSlugName(wtName)) {
        throw new Error(`worktree.${wtId}.name must be ${SLUG_NAME_HINT}`);
      }
      const wtPath = requireString(rawWt, "path", `worktree.${wtId}`);
      if (!Array.isArray(rawWt.labels) || !rawWt.labels.every((l) => typeof l === "string")) {
        throw new Error(`worktree.${wtId}.labels must be a string array`);
      }
      const wt: AgentHostRecord["repositories"][0]["worktrees"][0] = {
        id: wtId,
        name: wtName,
        path: wtPath,
        labels: rawWt.labels as string[],
      };
      if (rawWt.setupScript !== undefined) {
        if (typeof rawWt.setupScript !== "string") {
          throw new Error(`worktree.${wtId}.setupScript must be a string`);
        }
        wt.setupScript = rawWt.setupScript;
      }
      return wt;
    });
    const repo: AgentHostRecord["repositories"][0] = { id, path, defaultBranch, worktrees };
    if (rawRepo.setupScript !== undefined) {
      if (typeof rawRepo.setupScript !== "string") {
        throw new Error(`repository.${id}.setupScript must be a string`);
      }
      repo.setupScript = rawRepo.setupScript;
    }
    if (rawRepo.terminalHookScript !== undefined) {
      if (typeof rawRepo.terminalHookScript !== "string") {
        throw new Error(`repository.${id}.terminalHookScript must be a string`);
      }
      repo.terminalHookScript = rawRepo.terminalHookScript;
    }
    repositories.push(repo);
  }

  if (!isRecord(body.commandProfiles)) {
    throw new Error("commandProfiles must be an object");
  }
  const commandProfiles: AgentHostRecord["commandProfiles"] = {};
  for (const [name, profile] of Object.entries(body.commandProfiles)) {
    if (!isRecord(profile)) {
      throw new Error(`commandProfiles.${name} must be an object`);
    }
    if (
      !Array.isArray(profile.argv) ||
      profile.argv.length === 0 ||
      !profile.argv.every((a) => typeof a === "string" && a.length > 0)
    ) {
      throw new Error(`commandProfiles.${name}.argv must be a non-empty string array`);
    }
    commandProfiles[name] = {
      argv: profile.argv as string[],
      appendPrompt: profile.appendPrompt !== false,
    };
  }

  let logLevel: AgentHostRecord["logLevel"];
  if (
    body.logLevel === "debug" ||
    body.logLevel === "info" ||
    body.logLevel === "warn" ||
    body.logLevel === "error"
  ) {
    logLevel = body.logLevel;
  }

  return {
    agentId,
    repositories,
    commandProfiles,
    ...(logLevel !== undefined ? { logLevel } : {}),
  };
}

function syncWorktreesFromHost(state: ControlPlaneState, host: AgentHostRecord): void {
  const online = state.agentConnection.has(host.agentId);
  const configuredIds = new Set<string>();
  for (const repo of host.repositories) {
    for (const wt of repo.worktrees) {
      configuredIds.add(wt.id);
      const prev = state.worktrees.get(wt.id);
      persistWorktree(state, {
        id: wt.id,
        name: wt.name,
        agentId: host.agentId,
        repositoryId: repo.id,
        path: wt.path,
        labels: wt.labels,
        status: prev && prev.status === "busy" ? "busy" : "idle",
        online: prev ? prev.online : online,
        currentSessionId: prev && prev.currentSessionId != null ? prev.currentSessionId : null,
        lastAssignedAt: prev && prev.lastAssignedAt != null ? prev.lastAssignedAt : null,
      });
    }
  }
  // Host inventory is authoritative: drop worktrees no longer listed for this agent.
  for (const [id, wt] of state.worktrees) {
    if (wt.agentId === host.agentId && !configuredIds.has(id) && wt.status !== "busy") {
      state.worktrees.delete(id);
    }
  }
}

export function putAgentHostConfig(
  state: ControlPlaneState,
  agentId: string,
  body: unknown,
): { ok: true; config: AgentHostRecord } | { ok: false; error: string } {
  try {
    const parsed = parseHostBody(agentId, body);
    const collision = findWorktreeNameCollision(state, agentId, parsed);
    if (collision) {
      return { ok: false, error: collision };
    }
    const rec: AgentHostRecord = { ...parsed, updatedAt: state.now() };
    state.agentHosts.set(agentId, rec);
    if (state.storage) {
      queueWrite(state, state.storage.putAgentHost({ ...rec }));
    }
    syncWorktreesFromHost(state, rec);
    return { ok: true, config: { ...rec } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function getAgentHostConfig(
  state: ControlPlaneState,
  agentId: string,
): AgentHostRecord | null {
  const rec = state.agentHosts.get(agentId);
  return rec ? { ...rec } : null;
}

export function listAgentHostConfigs(state: ControlPlaneState): AgentHostRecord[] {
  return [...state.agentHosts.values()]
    .toSorted((a, b) => a.agentId.localeCompare(b.agentId))
    .map((h) => ({ ...h }));
}

export function deleteAgentHostConfig(
  state: ControlPlaneState,
  agentId: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.agentHosts.has(agentId)) {
    return { ok: false, error: "agent host config not found" };
  }
  state.agentHosts.delete(agentId);
  if (state.storage) {
    queueWrite(state, state.storage.deleteAgentHost(agentId));
  }
  // The host is gone entirely, so its worktree names must be released too —
  // otherwise they stay permanently reserved against a host that no longer exists.
  for (const [id, wt] of state.worktrees) {
    if (wt.agentId === agentId) {
      state.worktrees.delete(id);
    }
  }
  return { ok: true };
}
