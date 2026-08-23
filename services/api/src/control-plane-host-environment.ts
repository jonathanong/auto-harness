import type { ControlPlaneState } from "./control-plane-state.ts";

type RepositoryEnvironmentReadiness = {
  required: string[];
  missing: string[];
  ready: boolean;
};

export function repositoryEnvironmentReadiness(
  state: ControlPlaneState,
  hostId: string,
  repositoryId: string,
): RepositoryEnvironmentReadiness {
  const inventory = state.hostInventories.get(hostId);
  const repository = inventory?.repositories.find((item) => item.id === repositoryId);
  const required = [
    ...(inventory?.requiredEnvironment ?? []),
    ...(repository?.requiredEnvironment ?? []),
  ].filter((name, index, names) => names.indexOf(name) === index);
  const connectionId = state.hostConnection.get(hostId);
  const runtime = connectionId ? state.connections.get(connectionId)?.runtime : inventory?.runtime;
  // Older daemons did not report their platform semantics. Preserve the former
  // exact-match behavior for those reports; only a current Windows daemon can
  // opt into its case-insensitive child-environment lookup semantics.
  const caseSensitive = runtime?.environmentNamesCaseSensitive !== false;
  const available = new Set(
    (runtime?.environmentNames ?? []).map((name) => (caseSensitive ? name : name.toUpperCase())),
  );
  const missing = required.filter(
    (name) => !available.has(caseSensitive ? name : name.toUpperCase()),
  );
  return { required, missing, ready: missing.length === 0 };
}

export function hostEnvironmentReady(
  state: ControlPlaneState,
  hostId: string,
  repositoryId: string,
): boolean {
  return repositoryEnvironmentReadiness(state, hostId, repositoryId).ready;
}
