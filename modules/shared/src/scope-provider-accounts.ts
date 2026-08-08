import type { HostInventory, ProviderAccountOverride } from "./host-inventory.ts";

export type ProviderAccountScope = { repositoryId: string; worktreeId?: string };

type Overridable = { providerAccountOverrides?: Record<string, ProviderAccountOverride> };

function withOverride<T extends Overridable>(
  target: T,
  providerAccountId: string,
  mutate: (current: ProviderAccountOverride) => ProviderAccountOverride,
): T {
  const current = target.providerAccountOverrides?.[providerAccountId] ?? {};
  const patched = mutate(current);
  const overrides = { ...target.providerAccountOverrides };
  if (patched.enabled === undefined && patched.commandId === undefined) {
    delete overrides[providerAccountId];
  } else {
    overrides[providerAccountId] = patched;
  }
  const next = { ...target };
  if (Object.keys(overrides).length > 0) {
    next.providerAccountOverrides = overrides;
  } else {
    delete next.providerAccountOverrides;
  }
  return next;
}

function withScope(
  inventory: HostInventory,
  scope: ProviderAccountScope,
  providerAccountId: string,
  mutate: (current: ProviderAccountOverride) => ProviderAccountOverride,
): HostInventory {
  return {
    ...inventory,
    repositories: inventory.repositories.map((r) => {
      if (r.id !== scope.repositoryId) {
        return r;
      }
      if (scope.worktreeId === undefined) {
        return withOverride(r, providerAccountId, mutate);
      }
      return {
        ...r,
        worktrees: r.worktrees.map((w) =>
          w.id === scope.worktreeId ? withOverride(w, providerAccountId, mutate) : w,
        ),
      };
    }),
  };
}

/** Set, or (when `enabled` is `undefined`) clear back to inherited, a scope's enable override. */
export function setScopeProviderEnabled(
  inventory: HostInventory,
  scope: ProviderAccountScope,
  providerAccountId: string,
  enabled: boolean | undefined,
): HostInventory {
  return withScope(inventory, scope, providerAccountId, (current) => {
    const next = { ...current };
    if (enabled === undefined) {
      delete next.enabled;
    } else {
      next.enabled = enabled;
    }
    return next;
  });
}

/** Set, or (when `commandId` is `undefined`) clear back to inherited, a scope's command override. */
export function setScopeProviderCommand(
  inventory: HostInventory,
  scope: ProviderAccountScope,
  providerAccountId: string,
  commandId: string | undefined,
): HostInventory {
  return withScope(inventory, scope, providerAccountId, (current) => {
    const next = { ...current };
    if (commandId === undefined) {
      delete next.commandId;
    } else {
      next.commandId = commandId;
    }
    return next;
  });
}
