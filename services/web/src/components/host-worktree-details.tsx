import Link from "next/link";
import { Badge } from "@auto-harness/ui";

export type FleetWorktree = {
  id: string;
  name: string;
  hostId: string;
  repositoryId: string;
  path: string;
  labels?: string[];
  status: string;
  currentSessionId?: string | null;
};

export function HostWorktreeDetails({
  hostId,
  worktrees,
}: {
  hostId: string;
  worktrees: FleetWorktree[];
}) {
  const busy = worktrees.filter((worktree) => worktree.status === "busy").length;
  return (
    <details data-pw={`host-worktrees-${hostId}`}>
      <summary className="cursor-pointer whitespace-nowrap text-sm font-medium">
        {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"} · {busy} busy
      </summary>
      {worktrees.length ? (
        <ul className="mt-2 min-w-72 space-y-2">
          {worktrees.map((worktree) => (
            <li key={worktree.id} className="rounded-md border border-border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/worktrees/${encodeURIComponent(worktree.id)}`}
                  className="font-medium hover:underline"
                  data-pw={`host-worktree-link-${worktree.id}`}
                >
                  {worktree.name}
                </Link>
                <Badge variant="outline">{worktree.status}</Badge>
                {worktree.labels?.map((label) => (
                  <Badge key={label} variant="secondary">
                    {label}
                  </Badge>
                ))}
              </div>
              <div className="mt-1 break-all font-mono text-muted-foreground">{worktree.path}</div>
              <div className="mt-1">
                Repository:{" "}
                <Link
                  href={`/repositories/${encodeURIComponent(worktree.repositoryId)}`}
                  className="font-mono hover:underline"
                >
                  {worktree.repositoryId}
                </Link>
              </div>
              <div>
                Current session:{" "}
                {worktree.currentSessionId ? (
                  <Link
                    href={`/sessions/${encodeURIComponent(worktree.currentSessionId)}`}
                    className="font-mono hover:underline"
                  >
                    {worktree.currentSessionId}
                  </Link>
                ) : (
                  "None"
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No worktrees configured.</p>
      )}
    </details>
  );
}
