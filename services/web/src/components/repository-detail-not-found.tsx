import Link from "next/link";

/** 404 chrome when `/repositories/[id]` is not in the catalog. */
export function RepositoryDetailNotFound({ repositoryId }: { repositoryId: string }) {
  return (
    <div className="space-y-4" data-pw="page-repository-detail-not-found">
      <Link href="/repositories" className="text-sm text-muted-foreground hover:underline">
        ← Back to repositories
      </Link>
      <p className="text-sm text-muted-foreground">
        No repository <code className="font-mono">{repositoryId}</code> registered with the control
        plane.
      </p>
    </div>
  );
}
