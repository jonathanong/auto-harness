import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";

export type RepositorySummary = {
  id: string;
  name?: string | null;
  /** Host path (host pane) — prefer over `url` when both are present. */
  path?: string | null;
  /** Catalog URL/path (control plane). */
  url?: string | null;
  defaultBranch?: string | null;
  setupScript?: string | null;
  terminalHookScript?: string | null;
};

export type RepositoryDetailProps = {
  repository: RepositorySummary;
  backHref: string;
  /** Rendered top-right (e.g. a remove button). */
  actions?: ReactNode;
  /** Rendered below the details card (e.g. worktrees + sessions sections). */
  children?: ReactNode;
};

/** Shared repository detail view — reused by the host pane and control page. */
export function RepositoryDetail({
  repository: r,
  backHref,
  actions,
  children,
}: RepositoryDetailProps) {
  return (
    <div className="space-y-6" data-pw="repository-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={backHref}
            className="text-sm text-muted-foreground hover:underline"
            data-pw="repository-detail-back"
          >
            ← Back to repositories
          </Link>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="repository-detail-id">
            {r.name ?? r.id}
          </h2>
        </div>
        {actions}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Id</dt>
              <dd className="font-mono text-xs text-muted-foreground">{r.id}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase text-muted-foreground">Path / URL</dt>
              <dd className="break-all font-mono text-sm" data-pw="repository-detail-path">
                {r.path ?? r.url ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Default branch</dt>
              <dd className="font-mono text-sm">{r.defaultBranch ?? "main"}</dd>
            </div>
          </dl>
          {r.setupScript ? (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Setup script</dt>
              <dd>
                <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                  {r.setupScript}
                </pre>
              </dd>
            </div>
          ) : null}
          {r.terminalHookScript ? (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Terminal hook script</dt>
              <dd>
                <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                  {r.terminalHookScript}
                </pre>
              </dd>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {children}
    </div>
  );
}
