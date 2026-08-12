import {
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";

/** Every catalog provider/command is selectable. Availability is a hint only. */
export type SessionTarget =
  | { kind: "provider"; id: string; label: string; available: boolean }
  | { kind: "command"; id: string; label: string; providerId: string | null; available: boolean };

export function listSessionTargets(state: ControlPlaneState): SessionTarget[] {
  const now = Date.parse(state.now());
  const catalog: ProviderCatalog = {
    providers: Object.fromEntries(state.providers),
    providerAccounts: Object.fromEntries(state.providerAccounts),
  };
  const healthyFor = (providerId: string): boolean =>
    [...state.worktrees.values()].some((worktree) =>
      [...state.providerAccounts.values()]
        .filter((account) => account.providerId === providerId)
        .some((account) => accountCanRunOnWorktree(state, catalog, account.id, worktree, now)),
    );
  const providerCommandAvailable = (providerId: string): boolean =>
    [...state.worktrees.values()].some((worktree) =>
      [...state.providerAccounts.values()]
        .filter((account) => account.providerId === providerId)
        .some((account) => accountEnabledOnWorktree(state, account.id, worktree, now)),
    );
  const standaloneAvailable = [...state.worktrees.values()].some((worktree) =>
    isAvailableWorktree(state, worktree),
  );
  const providers: SessionTarget[] = [...state.providers.values()].map((provider) => ({
    kind: "provider",
    id: provider.id,
    label: provider.name,
    available: healthyFor(provider.id),
  }));
  const commands: SessionTarget[] = [...state.commands.values()].map((command) => ({
    kind: "command",
    id: command.id,
    label: command.name,
    providerId: command.providerId,
    available:
      command.providerId === null
        ? standaloneAvailable
        : command.argv.length > 0 && providerCommandAvailable(command.providerId),
  }));
  return [...providers, ...commands].toSorted((a, b) => a.label.localeCompare(b.label));
}

function isAvailableWorktree(
  state: ControlPlaneState,
  worktree: { hostId: string; status: string; online: boolean },
): boolean {
  return (
    worktree.status === "idle" &&
    worktree.online &&
    !state.drainingHosts.has(worktree.hostId) &&
    !state.disconnectedHosts.has(worktree.hostId)
  );
}

function accountCanRunOnWorktree(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  providerAccountId: string,
  worktree: { id: string; hostId: string; repositoryId: string; status: string; online: boolean },
  now: number,
): boolean {
  if (!accountEnabledOnWorktree(state, providerAccountId, worktree, now)) return false;
  const host = state.hostInventories.get(worktree.hostId);
  const repository = host?.repositories.find((item) => item.id === worktree.repositoryId);
  const hostWorktree = repository?.worktrees.find((item) => item.id === worktree.id);
  const commandId = resolveProviderAccountCommandId(
    providerAccountId,
    hostWorktree,
    repository,
    host,
    catalog,
  );
  return commandId !== undefined && (state.commands.get(commandId)?.argv.length ?? 0) > 0;
}

function accountEnabledOnWorktree(
  state: ControlPlaneState,
  providerAccountId: string,
  worktree: { id: string; hostId: string; repositoryId: string; status: string; online: boolean },
  now: number,
): boolean {
  if (!isAvailableWorktree(state, worktree)) return false;
  const account = state.providerAccounts.get(providerAccountId);
  if (
    !account ||
    (account.usageLimitedUntil !== null && Date.parse(account.usageLimitedUntil) > now)
  ) {
    return false;
  }
  const host = state.hostInventories.get(worktree.hostId);
  const repository = host?.repositories.find((item) => item.id === worktree.repositoryId);
  const hostWorktree = repository?.worktrees.find((item) => item.id === worktree.id);
  return resolveProviderAccountEnabled(providerAccountId, hostWorktree, repository, host);
}
