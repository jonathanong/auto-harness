import { MAX_FALLBACKS } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

/** Refresh only catalog rows reachable from bounded assignment candidates. */
export async function refreshAssignmentCommandsDurable(
  state: ControlPlaneState,
  sessions: readonly SessionRecord[],
  maxCommands = Math.max(1, sessions.length * (MAX_FALLBACKS + 1)),
): Promise<ReadonlySet<string>> {
  const storage = state.storage;
  if (!storage || maxCommands <= 0) return new Set();
  const commandIds = new Set<string>();
  const providerIds = new Set<string>();
  const accountIds = new Set<string>();
  const hostIds = new Set<string>();
  const repositoryIds = new Set(sessions.map((session) => session.repositoryId));
  for (const session of sessions) {
    if (session.pinnedCommandId) commandIds.add(session.pinnedCommandId);
    if (session.resolvedRoute?.commandId) commandIds.add(session.resolvedRoute.commandId);
    for (const target of [session.target, ...session.fallbacks]) {
      if ("commandId" in target) commandIds.add(target.commandId);
      else providerIds.add(target.providerId);
    }
    for (const worktree of state.worktrees.values()) {
      if (worktree.repositoryId === session.repositoryId) hostIds.add(worktree.hostId);
    }
    for (const connection of state.connections.values()) {
      if (connection.repositoryIds?.includes(session.repositoryId)) hostIds.add(connection.hostId);
    }
  }
  const refreshedHostIds = new Set([...hostIds].slice(0, Math.max(1, sessions.length)));
  for (const hostId of hostIds) {
    if (!refreshedHostIds.has(hostId)) state.hostInventories.delete(hostId);
  }
  await Promise.all(
    [...refreshedHostIds].map(async (hostId) => {
      const inventory = await storage.getHostInventory(hostId);
      if (inventory) state.hostInventories.set(hostId, { ...inventory });
      else state.hostInventories.delete(hostId);
    }),
  );
  for (const hostId of refreshedHostIds) {
    const inventory = state.hostInventories.get(hostId);
    if (!inventory) continue;
    for (const account of inventory.providerAccounts) {
      accountIds.add(account.providerAccountId);
      if (account.commandId) commandIds.add(account.commandId);
    }
    for (const repository of inventory.repositories) {
      if (!repositoryIds.has(repository.id)) continue;
      for (const override of Object.values(repository.providerAccountOverrides ?? {})) {
        if (override.commandId) commandIds.add(override.commandId);
      }
      for (const worktree of repository.worktrees) {
        for (const override of Object.values(worktree.providerAccountOverrides ?? {})) {
          if (override.commandId) commandIds.add(override.commandId);
        }
      }
    }
  }
  await Promise.all(
    [...accountIds].map(async (id) => {
      const account = await storage.getProviderAccount(id);
      if (account) {
        state.providerAccounts.set(id, { ...account });
        providerIds.add(account.providerId);
      } else state.providerAccounts.delete(id);
    }),
  );
  await Promise.all(
    [...providerIds].map(async (id) => {
      const provider = await storage.getProvider(id);
      if (provider) {
        state.providers.set(id, { ...provider });
        if (provider.defaultCommandId) commandIds.add(provider.defaultCommandId);
      } else state.providers.delete(id);
    }),
  );
  const selected = [...commandIds].slice(0, maxCommands);
  const selectedIds = new Set(selected);
  for (const id of commandIds) {
    if (!selectedIds.has(id)) state.commands.delete(id);
  }
  const refreshed = new Set<string>();
  await Promise.all(
    selected.map(async (id) => {
      const command = await storage.getCommand(id);
      if (command) {
        state.commands.set(id, { ...command });
        refreshed.add(id);
      } else state.commands.delete(id);
    }),
  );
  return refreshed;
}
