type CommandOverrideInventory = ReadonlyArray<{
  hostId: string;
  repositories: Array<{
    id: string;
    providerAccountOverrides?: Record<string, { commandId?: string }>;
    worktrees: Array<{
      id: string;
      providerAccountOverrides?: Record<string, { commandId?: string }>;
    }>;
  }>;
  providerAccounts: Array<{ commandId?: string }>;
}>;

type DependencyLabelInput = {
  kind: string;
  id: string;
  status?: string;
  scope?: "host" | "repository" | "worktree";
  hostId?: string;
  repositoryId?: string;
  worktreeId?: string;
};

export function commandOverrideDependencies(
  inventories: CommandOverrideInventory,
  commandId: string,
) {
  const dependencies: Array<{
    kind: "host-inventory";
    id: string;
    scope: "host" | "repository" | "worktree";
    hostId: string;
    repositoryId?: string;
    worktreeId?: string;
  }> = [];
  for (const inventory of inventories) {
    if (inventory.providerAccounts.some((account) => account.commandId === commandId)) {
      dependencies.push({
        kind: "host-inventory",
        id: inventory.hostId,
        scope: "host",
        hostId: inventory.hostId,
      });
    }
    for (const repository of inventory.repositories) {
      if (hasOverride(repository.providerAccountOverrides, commandId)) {
        dependencies.push({
          kind: "host-inventory",
          id: inventory.hostId,
          scope: "repository",
          hostId: inventory.hostId,
          repositoryId: repository.id,
        });
      }
      for (const worktree of repository.worktrees) {
        if (hasOverride(worktree.providerAccountOverrides, commandId)) {
          dependencies.push({
            kind: "host-inventory",
            id: inventory.hostId,
            scope: "worktree",
            hostId: inventory.hostId,
            repositoryId: repository.id,
            worktreeId: worktree.id,
          });
        }
      }
    }
  }
  return dependencies;
}

export function deleteDependencyLabel(dependency: DependencyLabelInput): string {
  if (dependency.scope === "host") return `host ${dependency.hostId} command override`;
  if (dependency.scope === "repository") {
    return `repository ${dependency.repositoryId} command override on host ${dependency.hostId}`;
  }
  if (dependency.scope === "worktree") {
    return `worktree ${dependency.worktreeId} command override on host ${dependency.hostId}`;
  }
  return `${dependency.kind} ${dependency.id}${dependency.status ? ` (${dependency.status})` : ""}`;
}

function hasOverride(
  overrides: Record<string, { commandId?: string }> | undefined,
  commandId: string,
): boolean {
  return Object.values(overrides ?? {}).some((override) => override.commandId === commandId);
}
