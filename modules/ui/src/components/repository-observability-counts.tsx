type RepositoryCounts = {
  repositoryId: string;
  sessionCount?: number;
  worktreeCount?: number;
  scheduleCount?: number;
};

export function RepositoryObservabilityCounts({ repository: r }: { repository: RepositoryCounts }) {
  if (
    r.sessionCount === undefined ||
    r.worktreeCount === undefined ||
    r.scheduleCount === undefined
  )
    return null;
  return (
    <dl className="flex shrink-0 flex-wrap justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {[
        ["Sessions", r.sessionCount, "sessions"],
        ["Worktrees", r.worktreeCount, "worktrees"],
        ["Schedules", r.scheduleCount, "schedules"],
      ].map(([label, count, key]) => (
        <div key={key} className="text-right" data-pw={`repo-count-${key}-${r.repositoryId}`}>
          <dt>{label}</dt>
          <dd className="font-semibold text-foreground">{count}</dd>
        </div>
      ))}
    </dl>
  );
}
