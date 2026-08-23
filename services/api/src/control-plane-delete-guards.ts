/* eslint-disable max-lines */
import type { TargetRef } from "@auto-harness/shared";
import { isActiveSessionStatus } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
import type { CommandRecord, ProviderAccountRecord, ProviderRecord } from "./db/plane-storage.ts";
import {
  commandOverrideDependencies,
  deleteDependencyLabel,
} from "./control-plane-command-delete-overrides.ts";

export type DeleteDependency = {
  kind:
    | "schedule"
    | "session"
    | "provider"
    | "provider-account"
    | "command"
    | "worktree"
    | "host-inventory"
    | "session-drain";
  id: string;
  status?: string;
  /** Precise location when a host inventory's provider-account command override owns the ref. */
  scope?: "host" | "repository" | "worktree";
  hostId?: string;
  repositoryId?: string;
  worktreeId?: string;
  providerAccountId?: string;
};

export type DeleteResult =
  | { ok: true }
  | { ok: false; error: string; conflict?: boolean; dependencies?: DeleteDependency[] };

export type DeleteReferences = {
  schedules: ReadonlyArray<{
    id: string;
    repositoryId: string;
    principalId?: string;
    target: TargetRef;
    fallbacks: TargetRef[];
  }>;
  sessions: ReadonlyArray<SessionRecord>;
  sessionDrains: ReadonlyArray<{
    recordKey: string;
    operationId: string;
    repositoryId: string;
    principalId: string;
    status: string;
  }>;
  worktrees: ReadonlyArray<{ id: string; repositoryId: string }>;
  inventories: ReadonlyArray<{
    hostId: string;
    repositories: Array<{
      id: string;
      providerAccountOverrides?: Record<string, { commandId?: string }>;
      worktrees: Array<{
        id: string;
        providerAccountOverrides?: Record<string, { commandId?: string }>;
      }>;
    }>;
    providerAccounts: Array<{ providerAccountId: string; commandId?: string }>;
  }>;
  providers: ReadonlyArray<ProviderRecord>;
  accounts: ReadonlyArray<ProviderAccountRecord>;
  commands: ReadonlyArray<CommandRecord>;
};

export function referencesFromState(state: ControlPlaneState): DeleteReferences {
  return {
    schedules: [...state.schedules.values()],
    sessions: [...state.sessions.values()],
    sessionDrains: [],
    worktrees: [...state.worktrees.values()],
    inventories: [...state.hostInventories.values()],
    providers: [...state.providers.values()],
    accounts: [...state.providerAccounts.values()],
    commands: [...state.commands.values()],
  };
}

/** Fetch the objects which can hold a live catalog reference before a durable delete. */
export async function refreshDeleteReferences(state: ControlPlaneState): Promise<DeleteReferences> {
  if (!state.storage) return referencesFromState(state);
  const [
    schedules,
    sessions,
    sessionDrains,
    worktrees,
    inventories,
    providers,
    accounts,
    commands,
  ] = await Promise.all([
    state.storage.listSchedules(),
    state.storage.listAllSessions(true),
    state.storage.listSessionDrains(true),
    state.storage.listAllWorktrees(true),
    state.storage.listHostInventories(),
    state.storage.listProviders(),
    state.storage.listProviderAccounts(),
    state.storage.listCommands(),
  ]);
  return {
    schedules,
    sessions,
    sessionDrains,
    worktrees,
    inventories,
    providers,
    accounts,
    commands,
  };
}

export function dependenciesForProvider(refs: DeleteReferences, id: string): DeleteDependency[] {
  const dependencies: DeleteDependency[] = [];
  for (const account of refs.accounts)
    if (account.providerId === id) dependencies.push({ kind: "provider-account", id: account.id });
  for (const command of refs.commands)
    if (command.providerId === id) dependencies.push({ kind: "command", id: command.id });
  for (const schedule of refs.schedules)
    if (referencesProvider(schedule.target, schedule.fallbacks, id))
      dependencies.push({ kind: "schedule", id: schedule.id });
  for (const session of live(refs.sessions))
    if (referencesProvider(session.target, session.fallbacks, id))
      dependencies.push(sessionDependency(session));
  return unique(dependencies);
}

export function dependenciesForAccount(refs: DeleteReferences, id: string): DeleteDependency[] {
  const dependencies: DeleteDependency[] = [];
  for (const inventory of refs.inventories) {
    const attached =
      inventory.providerAccounts.some((account) => account.providerAccountId === id) ||
      inventory.repositories.some(
        (repository) =>
          id in (repository.providerAccountOverrides ?? {}) ||
          repository.worktrees.some((worktree) => id in (worktree.providerAccountOverrides ?? {})),
      );
    if (attached) dependencies.push({ kind: "host-inventory", id: inventory.hostId });
  }
  for (const session of live(refs.sessions))
    if (session.resolvedRoute?.providerAccountId === id || session.pinnedProviderAccountId === id)
      dependencies.push(sessionDependency(session));
  return unique(dependencies);
}

export function dependenciesForCommand(refs: DeleteReferences, id: string): DeleteDependency[] {
  const dependencies: DeleteDependency[] = [];
  for (const provider of refs.providers)
    if (provider.defaultCommandId === id) dependencies.push({ kind: "provider", id: provider.id });
  dependencies.push(...commandOverrideDependencies(refs.inventories, id));
  for (const schedule of refs.schedules)
    if (referencesCommand(schedule.target, schedule.fallbacks, id))
      dependencies.push({ kind: "schedule", id: schedule.id });
  for (const session of live(refs.sessions))
    if (
      referencesCommand(session.target, session.fallbacks, id) ||
      session.resolvedRoute?.commandId === id ||
      session.pinnedCommandId === id
    )
      dependencies.push(sessionDependency(session));
  return unique(dependencies);
}

export function dependenciesForRepository(refs: DeleteReferences, id: string): DeleteDependency[] {
  return unique([
    ...refs.schedules
      .filter((schedule) => schedule.repositoryId === id)
      .map((schedule) => ({ kind: "schedule" as const, id: schedule.id })),
    ...live(refs.sessions)
      .filter((session) => session.repositoryId === id)
      .map(sessionDependency),
    ...refs.sessionDrains
      .filter(
        (drain) =>
          drain.recordKey === "CURRENT" && drain.repositoryId === id && drain.status !== "released",
      )
      .map((drain) => ({
        kind: "session-drain" as const,
        id: drain.operationId,
        status: drain.status,
      })),
    ...refs.worktrees
      .filter((worktree) => worktree.repositoryId === id)
      .map((worktree) => ({ kind: "worktree" as const, id: worktree.id })),
    ...refs.inventories
      .filter((inventory) => inventory.repositories.some((repository) => repository.id === id))
      .map((inventory) => ({ kind: "host-inventory" as const, id: inventory.hostId })),
  ]);
}

/**
 * An account cannot disappear while it still owns runnable scheduled work or
 * an unreleased principal-admission fence. Keeping the owner durable avoids
 * silently turning either record into an unactionable legacy row.
 */
export function dependenciesForPrincipal(refs: DeleteReferences, id: string): DeleteDependency[] {
  return unique([
    ...refs.schedules
      .filter((schedule) => schedule.principalId === id)
      .map((schedule) => ({ kind: "schedule" as const, id: schedule.id })),
    ...refs.sessionDrains
      .filter(
        (drain) =>
          drain.recordKey === "CURRENT" && drain.principalId === id && drain.status !== "released",
      )
      .map((drain) => ({
        kind: "session-drain" as const,
        id: drain.operationId,
        status: drain.status,
      })),
  ]);
}

export function deleteConflict(subject: string, dependencies: DeleteDependency[]): DeleteResult {
  if (dependencies.length === 0) return { ok: true };
  return {
    ok: false,
    conflict: true,
    dependencies,
    error: `cannot delete ${subject}; referenced by ${dependencies.map(deleteDependencyLabel).join(", ")}`,
  };
}
const live = (sessions: ReadonlyArray<SessionRecord>) =>
  sessions.filter((session) => isActiveSessionStatus(session.status));
const sessionDependency = (session: SessionRecord): DeleteDependency => ({
  kind: "session",
  id: session.id,
  status: session.status,
});
const referencesProvider = (target: TargetRef, fallbacks: TargetRef[], id: string) =>
  [target, ...fallbacks].some((route) => "providerId" in route && route.providerId === id);
const referencesCommand = (target: TargetRef, fallbacks: TargetRef[], id: string) =>
  [target, ...fallbacks].some((route) => "commandId" in route && route.commandId === id);
const unique = (dependencies: DeleteDependency[]) => [
  ...new Map(
    dependencies.map((dependency) => [
      `${dependency.kind}:${dependency.id}:${dependency.scope ?? ""}:${dependency.hostId ?? ""}:${dependency.repositoryId ?? ""}:${dependency.worktreeId ?? ""}:${dependency.providerAccountId ?? ""}`,
      dependency,
    ]),
  ).values(),
];
