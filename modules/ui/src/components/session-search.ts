export type SearchableSession = {
  id: string;
  status: string;
  repositoryId?: string | null;
  repositoryName?: string | null | undefined;
  prompt?: string | null;
  targetLabel?: string | null;
  targetDisplayNames?: string[] | null;
  target?: { providerId?: string; commandId?: string } | null;
  fallbacks?: Array<{ providerId?: string; commandId?: string }> | null;
  queueExpiresAt?: string | null;
  resolvedProviderAccountId?: string | null;
  resolvedCommandId?: string | null;
  resolvedHostId?: string | null;
  resolvedRoute?: {
    targetIndex?: number;
    providerAccountId?: string | null;
    commandId?: string | null;
    hostId?: string | null;
    worktreeId?: string | null;
  } | null;
  source?: string | null;
  priority?: number | null;
  requiredLabels?: string[] | null;
  concurrencyId?: string | null;
  hostId?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
};

/** Build the client-side search corpus for one loaded session. */
export function sessionSearchableText(session: SearchableSession): string {
  const values: Array<string | number | null | undefined> = [
    session.id,
    session.status,
    session.repositoryId,
    session.repositoryName,
    session.prompt,
    session.targetLabel,
    ...(session.targetDisplayNames ?? []),
    session.target?.providerId,
    session.target?.commandId,
    ...(session.fallbacks ?? []).flatMap((target) => [target.providerId, target.commandId]),
    session.queueExpiresAt,
    session.resolvedProviderAccountId,
    session.resolvedCommandId,
    session.resolvedHostId,
    session.resolvedRoute?.targetIndex == null
      ? undefined
      : `target ${session.resolvedRoute.targetIndex + 1}`,
    session.resolvedRoute?.providerAccountId,
    session.resolvedRoute?.commandId,
    session.resolvedRoute?.hostId,
    session.resolvedRoute?.worktreeId,
    session.source,
    session.priority,
    ...(session.requiredLabels ?? []),
    session.concurrencyId,
    session.hostId,
    session.createdAt,
    session.startedAt,
    session.completedAt,
    session.errorCode,
  ];

  return values
    .filter((value): value is string | number => value !== null && value !== undefined)
    .join("\n")
    .toLowerCase();
}

/** Match a normalized substring against fields already loaded for a session. */
export function sessionMatchesSearch(session: SearchableSession, search: string): boolean {
  const needle = search.trim().toLowerCase();
  return needle === "" || sessionSearchableText(session).includes(needle);
}
