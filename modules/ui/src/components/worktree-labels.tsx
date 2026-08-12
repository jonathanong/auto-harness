import { Badge } from "./badge.tsx";

export function WorktreeLabels({
  labels = [],
  worktreeId,
}: {
  labels?: string[];
  worktreeId: string;
}) {
  const unique = [...new Set(labels)].toSorted();
  if (unique.length === 0) return <span data-pw={`worktree-labels-${worktreeId}`}>—</span>;
  return (
    <div className="flex flex-wrap gap-1" data-pw={`worktree-labels-${worktreeId}`}>
      {unique.map((label) => (
        <Badge key={label} variant="outline" title={`Scheduler label: ${label}`}>
          <span className="whitespace-pre">{label}</span>
        </Badge>
      ))}
    </div>
  );
}
