type TargetRef = { providerId?: string; commandId?: string };

export type SessionRouteSummaryProps = {
  targetLabel?: string | null;
  targetLabels?: string[] | null;
  target?: TargetRef | null;
  fallbacks?: TargetRef[] | null;
  queueTtlSeconds?: number | null;
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
  hostId?: string | null;
  worktreeId?: string | null;
};

/** Shared route/queue metadata block for session detail pages. */
export function SessionRouteSummary({ session: s }: { session: SessionRouteSummaryProps }) {
  return (
    <>
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Target</dt>
        <dd className="font-mono text-sm" data-pw="session-detail-target">
          {s.targetLabel ?? s.targetLabels?.[0] ?? routeLabel(s.target) ?? "—"}
        </dd>
        {Math.max(s.fallbacks?.length ?? 0, Math.max((s.targetLabels?.length ?? 1) - 1, 0)) > 0 ? (
          <dd className="mt-1 text-xs text-muted-foreground" data-pw="session-detail-fallbacks">
            Fallbacks:{" "}
            {s.targetLabels?.slice(1).join(" → ") ||
              s.fallbacks?.map(routeLabel).filter(Boolean).join(" → ") ||
              "—"}
          </dd>
        ) : null}
      </div>
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Queue expiry</dt>
        <dd className="text-sm" data-pw="session-detail-queue-expiry">
          {s.queueExpiresAt ?? "—"}
          {s.queueTtlSeconds != null ? ` (${s.queueTtlSeconds}s TTL)` : ""}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Resolved route</dt>
        <dd className="font-mono text-xs" data-pw="session-detail-resolved-route">
          {s.resolvedRoute?.targetIndex != null
            ? `target ${s.resolvedRoute.targetIndex + 1}`
            : null}
          {s.resolvedRoute?.targetIndex != null ? <br /> : null}
          account: {s.resolvedProviderAccountId ?? s.resolvedRoute?.providerAccountId ?? "CLI"}
          <br />
          command: {s.resolvedCommandId ?? s.resolvedRoute?.commandId ?? "—"}
          <br />
          host: {s.resolvedHostId ?? s.resolvedRoute?.hostId ?? s.hostId ?? "CLI"}
          <br />
          worktree: {s.resolvedRoute?.worktreeId ?? s.worktreeId ?? "—"}
        </dd>
      </div>
    </>
  );
}

function routeLabel(target?: TargetRef | null): string | null {
  if (!target) return null;
  if (target.providerId) return `provider:${target.providerId}`;
  if (target.commandId) return `command:${target.commandId}`;
  return null;
}
