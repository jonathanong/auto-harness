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
  providerAccounts: Array<{ providerAccountId: string; commandId?: string }>;
}>;

type DependencyLabelInput = {
  kind: string;
  id: string;
  status?: string;
  scope?: "host" | "repository" | "worktree";
  hostId?: string;
  repositoryId?: string;
  worktreeId?: string;
  providerAccountId?: string;
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
    providerAccountId: string;
  }> = [];
  for (const inventory of inventories) {
    for (const account of inventory.providerAccounts) {
      if (account.commandId !== commandId) continue;
      dependencies.push({
        kind: "host-inventory",
        id: inventory.hostId,
        scope: "host",
        hostId: inventory.hostId,
        providerAccountId: account.providerAccountId,
      });
    }
    for (const repository of inventory.repositories) {
      for (const providerAccountId of matchingOverrides(
        repository.providerAccountOverrides,
        commandId,
      )) {
        dependencies.push({
          kind: "host-inventory",
          id: inventory.hostId,
          scope: "repository",
          hostId: inventory.hostId,
          repositoryId: repository.id,
          providerAccountId,
        });
      }
      for (const worktree of repository.worktrees) {
        for (const providerAccountId of matchingOverrides(
          worktree.providerAccountOverrides,
          commandId,
        )) {
          dependencies.push({
            kind: "host-inventory",
            id: inventory.hostId,
            scope: "worktree",
            hostId: inventory.hostId,
            repositoryId: repository.id,
            worktreeId: worktree.id,
            providerAccountId,
          });
        }
      }
    }
  }
  return dependencies;
}

export function deleteDependencyLabel(dependency: DependencyLabelInput): string {
  const account = dependency.providerAccountId
    ? ` (provider account ${dependency.providerAccountId})`
    : "";
  if (dependency.scope === "host") return `host ${dependency.hostId} command override${account}`;
  if (dependency.scope === "repository") {
    return `repository ${dependency.repositoryId} command override on host ${dependency.hostId}${account}`;
  }
  if (dependency.scope === "worktree") {
    return `worktree ${dependency.worktreeId} command override on host ${dependency.hostId}${account}`;
  }
  return `${dependency.kind} ${dependency.id}${dependency.status ? ` (${dependency.status})` : ""}`;
}

function matchingOverrides(
  overrides: Record<string, { commandId?: string }> | undefined,
  commandId: string,
): string[] {
  return Object.entries(overrides ?? {})
    .filter(([, override]) => override.commandId === commandId)
    .map(([providerAccountId]) => providerAccountId);
}
