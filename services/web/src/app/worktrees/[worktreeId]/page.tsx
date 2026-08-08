import Link from "next/link";
import type { HostInventory } from "@auto-harness/shared";
import {
  RemoveWorktreeButton,
  SessionsTable,
  Tabs,
  WorktreeDetail,
  WorktreeDetailsCard,
  type WorktreeRow,
} from "@auto-harness/ui";

import { EditWorktreeForm } from "../../../components/edit-worktree-form.tsx";
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
type Repo = { id: string; name: string; url: string };
type Session = {
  id: string;
  status: string;
  worktreeId?: string | null;
  agentId?: string | null;
  targetLabel?: string;
  prompt?: string;
  source?: string;
};

export default async function WorktreeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ worktreeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { worktreeId } = await params;
  const { tab } = await searchParams;

  let worktree: Wt | undefined;
  try {
    const data = await apiGet<{ items: Wt[] }>("/api/v1/worktrees");
    worktree = (data.items ?? []).find((w) => w.id === worktreeId);
  } catch {
    /* ignore — treated as not found below */
  }

  if (!worktree) {
    return (
      <div className="space-y-4" data-pw="page-worktree-detail-not-found">
        <Link href="/worktrees" className="text-sm text-muted-foreground hover:underline">
          ← Back to worktrees
        </Link>
        <p className="text-sm text-muted-foreground">
          No worktree <code className="font-mono">{worktreeId}</code> registered with the control
          plane.
        </p>
      </div>
    );
  }

  let repoPath: string | undefined;
  let repoName: string | undefined;
  let sessions: Session[] = [];
  try {
    const repos = await apiGet<{ items: Repo[] }>("/api/v1/repositories");
    const repo = repos.items?.find((r) => r.id === worktree!.repositoryId);
    repoPath = repo?.url;
    repoName = repo?.name;
  } catch {
    /* ignore — repo path/name stay unknown */
  }
  try {
    // No server-side worktreeId filter yet — scan the most recent page and filter here.
    const data = await apiGet<{ items: Session[] }>("/api/v1/sessions?limit=100");
    sessions = (data.items ?? []).filter((s) => s.worktreeId === worktreeId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  let inventory: HostInventory | null = null;
  if (worktree.agentId) {
    try {
      inventory = await apiGet<HostInventory>(
        `/api/v1/agents/${encodeURIComponent(worktree.agentId)}/config`,
      );
    } catch {
      /* ignore — edit/remove actions stay hidden below */
    }
  }
  const hostWorktree = inventory?.repositories
    .find((r) => r.id === worktree.repositoryId)
    ?.worktrees.find((w) => w.id === worktree.id);

  const row: WorktreeRow = {
    id: worktree.id,
    name: worktree.name,
    repositoryId: worktree.repositoryId,
    path: worktree.path,
    labels: worktree.labels,
    status: worktree.status,
    online: worktree.online,
    agentId: worktree.agentId,
  };

  return (
    <div data-pw="page-worktree-detail">
      <WorktreeDetail
        worktree={row}
        breadcrumbs={[{ label: "Worktrees", href: "/worktrees" }, { label: worktree.name }]}
        actions={
          worktree.agentId ? (
            <RemoveWorktreeButton
              agentId={worktree.agentId}
              repositoryId={worktree.repositoryId}
              worktreeId={worktree.id}
              redirectTo="/worktrees"
            />
          ) : null
        }
      >
        <Tabs
          basePath={`/worktrees/${encodeURIComponent(worktreeId)}`}
          active={typeof tab === "string" ? tab : "sessions"}
          pw="worktree-detail-tabs"
          tabs={[
            {
              key: "sessions",
              label: "Sessions",
              content: (
                <SessionsTable
                  items={sessions}
                  showAgent
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions in this worktree."
                />
              ),
            },
            {
              key: "settings",
              label: "Settings",
              content: (
                <div className="space-y-4">
                  <WorktreeDetailsCard
                    worktree={row}
                    repositoryName={repoName}
                    repoHrefBase="/repositories"
                    repoPath={repoPath}
                    hostHrefBase="/hosts"
                  />
                  {worktree.agentId && inventory && hostWorktree ? (
                    <EditWorktreeForm
                      agentId={worktree.agentId}
                      inventory={inventory}
                      repositoryId={worktree.repositoryId}
                      worktree={hostWorktree}
                    />
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </WorktreeDetail>
    </div>
  );
}
