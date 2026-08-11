import type { TargetRef } from "@auto-harness/shared";

import type { DeletionMarker } from "./db/plane-storage-deletion-markers.ts";
import type { DeleteReferences } from "./control-plane-delete-guards.ts";

export function referenceMarkers(
  now: string,
  reference: { repositoryId?: string; target?: TargetRef; fallbacks?: TargetRef[] },
): DeletionMarker[] {
  const keys = new Set<string>();
  if (reference.repositoryId) keys.add(`repository:${reference.repositoryId}`);
  for (const route of reference.target ? [reference.target, ...(reference.fallbacks ?? [])] : []) {
    keys.add("providerId" in route ? `provider:${route.providerId}` : `command:${route.commandId}`);
  }
  return markersFor(now, [...keys]);
}

export function markersFor(now: string, keys: readonly string[]): DeletionMarker[] {
  return [...new Set(keys)].toSorted().map((key) => ({ key, now }));
}

export function inventoryReferenceMarkers(
  now: string,
  inventory: DeleteReferences["inventories"][number],
): DeletionMarker[] {
  const keys = new Set<string>();
  for (const repository of inventory.repositories) {
    keys.add(`repository:${repository.id}`);
    for (const override of Object.values(repository.providerAccountOverrides ?? {})) {
      if (override.commandId) keys.add(`command:${override.commandId}`);
    }
    for (const worktree of repository.worktrees) {
      for (const override of Object.values(worktree.providerAccountOverrides ?? {})) {
        if (override.commandId) keys.add(`command:${override.commandId}`);
      }
    }
  }
  for (const account of inventory.providerAccounts) {
    keys.add(`provider-account:${account.providerAccountId}`);
    if (account.commandId) keys.add(`command:${account.commandId}`);
  }
  return markersFor(now, [...keys]);
}
