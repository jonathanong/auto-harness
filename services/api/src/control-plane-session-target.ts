import {
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
  type TargetRef,
} from "@auto-harness/shared";

import type { CommandRecord } from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

type ResolvedSessionRoute = {
  targetIndex: number;
  providerAccountId?: string;
  commandId: string;
  resolvedArgv: string[];
};

export function buildProviderCatalog(state: ControlPlaneState): ProviderCatalog {
  return {
    providers: Object.fromEntries(state.providers),
    providerAccounts: Object.fromEntries(state.providerAccounts),
  };
}

/** Resolve one worktree against the ordered route policy. */
export function resolveSessionTargetRoute(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
  nowMs: number,
): ResolvedSessionRoute | null {
  const targets = [session.target, ...session.fallbacks];
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    if (session.suppressedTargetIndexes?.includes(targetIndex)) continue;
    const target = targets[targetIndex]!;
    const route = resolveTarget(
      state,
      catalog,
      target,
      session.prompt,
      worktree,
      nowMs,
      session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
    );
    if (route && matchesNativeResumePin(session, { ...route, targetIndex })) {
      return { ...route, targetIndex };
    }
  }
  return null;
}

/** Resolve one explicit policy entry. Scheduler uses this to exhaust each target before fallbacks. */
export function resolveSessionTargetRouteAt(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
  nowMs: number,
  targetIndex: number,
): ResolvedSessionRoute | null {
  if (session.suppressedTargetIndexes?.includes(targetIndex)) return null;
  const target = [session.target, ...session.fallbacks][targetIndex];
  if (!target) return null;
  const route = resolveTarget(
    state,
    catalog,
    target,
    session.prompt,
    worktree,
    nowMs,
    session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
  );
  const resolved = route ? { ...route, targetIndex } : null;
  return resolved && matchesNativeResumePin(session, resolved) ? resolved : null;
}

/** A CLI resume is valid only on precisely the route that produced its ref. */
function matchesNativeResumePin(session: SessionRecord, route: ResolvedSessionRoute): boolean {
  if (!session.pinnedHostId) return true;
  if (session.pinnedTargetIndex !== undefined && session.pinnedTargetIndex !== route.targetIndex) {
    return false;
  }
  if (session.pinnedCommandId !== undefined && session.pinnedCommandId !== route.commandId) {
    return false;
  }
  return (
    !session.pinnedProviderAccountId || session.pinnedProviderAccountId === route.providerAccountId
  );
}

/** Kept as a narrow compatibility helper for daemon-facing execution code. */
export function resolveSessionTargetArgv(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
): string[] | null {
  return (
    resolveSessionTargetRoute(state, catalog, session, worktree, Date.parse(state.now()))
      ?.resolvedArgv ?? null
  );
}

function resolveTarget(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  target: TargetRef,
  prompt: string,
  worktree: WorktreeRecord,
  nowMs: number,
  pinnedProviderAccountId: string | null | undefined,
): Omit<ResolvedSessionRoute, "targetIndex"> | null {
  if ("commandId" in target) {
    const command = state.commands.get(target.commandId);
    if (!command) return null;
    if (command.providerId === null) {
      const resolvedArgv = buildArgv(command, prompt);
      return resolvedArgv ? { commandId: command.id, resolvedArgv } : null;
    }
    const account = resolveEligibleAccount(
      state,
      catalog,
      command.providerId,
      worktree,
      nowMs,
      pinnedProviderAccountId,
    );
    const resolvedArgv = buildArgv(command, prompt);
    return account && resolvedArgv
      ? { providerAccountId: account.id, commandId: command.id, resolvedArgv }
      : null;
  }
  const account = resolveEligibleAccount(
    state,
    catalog,
    target.providerId,
    worktree,
    nowMs,
    pinnedProviderAccountId,
  );
  if (!account) return null;
  const host = state.hostInventories.get(worktree.hostId);
  const repo = host?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = repo?.worktrees.find((w) => w.id === worktree.id);
  const commandId = resolveProviderAccountCommandId(account.id, hostWorktree, repo, host, catalog);
  const resolvedArgv = commandId ? buildArgv(state.commands.get(commandId), prompt) : null;
  return resolvedArgv && commandId
    ? { providerAccountId: account.id, commandId, resolvedArgv }
    : null;
}

function resolveEligibleAccount(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  providerId: string,
  worktree: WorktreeRecord,
  nowMs: number,
  pinnedProviderAccountId: string | null | undefined,
) {
  const host = state.hostInventories.get(worktree.hostId);
  const repo = host?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = repo?.worktrees.find((w) => w.id === worktree.id);
  return [...state.providerAccounts.values()]
    .filter((account) => account.providerId === providerId)
    .filter((account) => !pinnedProviderAccountId || account.id === pinnedProviderAccountId)
    .filter(
      (account) => !account.usageLimitedUntil || Date.parse(account.usageLimitedUntil) <= nowMs,
    )
    .filter((account) => resolveProviderAccountEnabled(account.id, hostWorktree, repo, host))
    .toSorted(
      (a, b) =>
        (a.lastAssignedAt ?? "").localeCompare(b.lastAssignedAt ?? "") || a.id.localeCompare(b.id),
    )[0];
}

function buildArgv(command: CommandRecord | undefined, prompt: string): string[] | null {
  if (!command || command.argv.length === 0) return null;
  return command.appendPrompt ? [...command.argv, prompt] : [...command.argv];
}
