import Link from "next/link";
import {
  RepositoryDetail,
  RepositoryDetailsCard,
  SessionsTable,
  Tabs,
  WorktreesHierarchy,
  type RepositorySummary,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";

import { apiGet } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";

type Wt = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  agentId?: string;
  labels?: string[];
};
type Session = {
  id: string;
  status: string;
  repositoryId?: string | null;
  agentId?: string | null;
  commandProfile?: string;
  prompt?: string;
  source?: string;
};

export default async function RepositoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: repositoryId } = await params;
  const { tab } = await searchParams;

  let repository: RepositorySummary | undefined;
  try {
    repository = await apiGet<RepositorySummary>(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
    );
  } catch {
    /* treated as not found below */
  }

  if (!repository) {
    return (
      <div className="space-y-4" data-pw="page-repository-detail-not-found">
        <Link href="/repositories" className="text-sm text-muted-foreground hover:underline">
          ← Back to repositories
        </Link>
        <p className="text-sm text-muted-foreground">
          No repository <code className="font-mono">{repositoryId}</code> registered with the
          control plane.
        </p>
      </div>
    );
  }

  let worktrees: Wt[] = [];
  try {
    const data = await apiGet<{ items: Wt[] }>("/api/v1/worktrees");
    worktrees = (data.items ?? []).filter((w) => w.repositoryId === repositoryId);
  } catch {
    /* ignore — worktrees section stays empty */
  }
  const group: WorktreeRepoGroup = {
    repositoryId,
    repositoryName: repository.name ?? repositoryId,
    repoPath: repository.path ?? repository.url ?? undefined,
    worktrees,
  };

  let sessions: Session[] = [];
  try {
    const data = await apiGet<{ items: Session[] }>("/api/v1/sessions?limit=100");
    sessions = (data.items ?? []).filter((s) => s.repositoryId === repositoryId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  return (
    <div data-pw="page-repository-detail">
      <RepositoryDetail repository={repository} backHref="/repositories">
        <Tabs
          basePath={`/repositories/${encodeURIComponent(repositoryId)}`}
          active={typeof tab === "string" ? tab : "sessions"}
          pw="repository-detail-tabs"
          tabs={[
            {
              key: "sessions",
              label: "Sessions",
              content: (
                <SessionsTable
                  items={sessions}
                  showAgent
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions for this repository."
                />
              ),
            },
            {
              key: "worktrees",
              label: "Worktrees",
              content: (
                <WorktreesHierarchy
                  groups={[group]}
                  showAgent
                  hrefBase="/worktrees"
                  emptyMessage="No worktrees registered for this repository."
                />
              ),
            },
            {
              key: "settings",
              label: "Settings",
              content: <RepositoryDetailsCard repository={repository} />,
            },
          ]}
        />
      </RepositoryDetail>
    </div>
  );
}
