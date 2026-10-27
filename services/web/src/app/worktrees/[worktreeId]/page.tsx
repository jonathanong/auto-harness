/* eslint-disable max-lines -- worktree detail composes sessions, provider scope, and settings tabs. */
import Link from "next/link";
import { resolveProviderAccountsForScope, type HostInventory } from "@auto-harness/shared";
import {
  RemoveWorktreeButton,
  SessionsTable,
  Tabs,
  WorktreeDetail,
  WorktreeDetailsCard,
  type WorktreeRow,
} from "@auto-harness/ui";

import { EditWorktreeForm } from "../../../components/edit-worktree-form.tsx";
import { ProviderScopeTable } from "../../../components/provider-scope-table.tsx";
import { apiGet, apiGetFirstPageWithItems } from "../../../lib/api.ts";
import { rethrowControlFlowError } from "../../../lib/page-error.ts";
import { fetchProviderCatalogLookups } from "../../../lib/provider-catalog-fetch.ts";
import { can, loadPrincipal } from "../../../lib/principal.ts";

export const dynamic = "force-dynamic";

type Wt = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  hostId?: string;
  labels?: string[];
};
type Repo = { id: string; name: string; url: string };
type Session = {
  id: string;
  status: string;
  worktreeId?: string | null;
  hostId?: string | null;
  targetLabel?: string;
  prompt?: string;
  source?: string;
};

const TAB_KEYS = ["sessions", "provider-accounts", "settings"];

async function loadRepository(repositoryId: string): Promise<Repo | undefined> {
  try {
    return await apiGet<Repo>(`/api/v1/repositories/${encodeURIComponent(repositoryId)}`);
  } catch (e) {
    /* ignore — repo path/name stay unknown */
    rethrowControlFlowError(e);
    return undefined;
  }
}

async function loadSessions(worktreeId: string): Promise<Session[]> {
  try {
    // No server-side worktreeId filter yet — scan bounded pages until this worktree appears.
    const data = await apiGetFirstPageWithItems<Session>(
      "/api/v1/sessions?limit=100",
      (session) => session.worktreeId === worktreeId,
    );
    return data.items.filter((s) => s.worktreeId === worktreeId);
  } catch (e) {
    /* ignore — sessions section stays empty */
    rethrowControlFlowError(e);
    return [];
  }
}

async function loadInventory(hostId: string): Promise<HostInventory | null> {
  try {
    return await apiGet<HostInventory>(`/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`);
  } catch (e) {
    /* ignore — edit/remove actions stay hidden below */
    rethrowControlFlowError(e);
    return null;
  }
}

export default async function WorktreeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ worktreeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { worktreeId } = await params;
  const { tab } = await searchParams;
  const canWriteExecConfig = can(await loadPrincipal(), "fleet:exec-config");

  let worktree: Wt | undefined;
  try {
    worktree = await apiGet<Wt>(`/api/v1/worktrees/${encodeURIComponent(worktreeId)}`);
  } catch (e) {
    /* ignore — treated as not found below */
    rethrowControlFlowError(e);
  }

  if (!worktree?.id) {
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

  // Each tab is a full server render, so only fetch what the active tab shows: the
  // sessions scan is the slowest call and must not block Settings or Provider accounts.
  const activeTab = typeof tab === "string" && TAB_KEYS.includes(tab) ? tab : "sessions";
  const wt = worktree;
  const [repo, sessions, inventory, catalogLookups] = await Promise.all([
    activeTab === "settings" ? loadRepository(wt.repositoryId) : undefined,
    activeTab === "sessions" ? loadSessions(worktreeId) : [],
    activeTab !== "sessions" && wt.hostId ? loadInventory(wt.hostId) : null,
    activeTab === "provider-accounts" ? fetchProviderCatalogLookups() : undefined,
  ]);
  const hostRepository = inventory?.repositories.find((r) => r.id === wt.repositoryId);
  const hostWorktree = hostRepository?.worktrees.find((w) => w.id === wt.id);
  const hasInheritedExecutionConfig =
    (inventory?.setupScript ?? "") !== "" ||
    (hostRepository?.setupScript ?? "") !== "" ||
    (hostRepository?.terminalHookScript ?? "") !== "";

  const row: WorktreeRow = {
    id: worktree.id,
    name: worktree.name,
    repositoryId: worktree.repositoryId,
    path: worktree.path,
    labels: worktree.labels,
    status: worktree.status,
    online: worktree.online,
    hostId: worktree.hostId,
  };

  return (
    <div data-pw="page-worktree-detail">
      <WorktreeDetail
        worktree={row}
        breadcrumbs={[{ label: "Worktrees", href: "/worktrees" }, { label: worktree.name }]}
        actions={
          worktree.hostId ? (
            <RemoveWorktreeButton
              hostId={worktree.hostId}
              repositoryId={worktree.repositoryId}
              worktreeId={worktree.id}
              redirectTo="/worktrees"
            />
          ) : null
        }
      >
        <Tabs
          basePath={`/worktrees/${encodeURIComponent(worktreeId)}`}
          active={activeTab}
          pw="worktree-detail-tabs"
          tabs={[
            {
              key: "sessions",
              label: "Sessions",
              content: (
                <SessionsTable
                  items={sessions}
                  showHost
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions in this worktree."
                />
              ),
            },
            {
              key: "provider-accounts",
              label: "Provider accounts",
              content:
                worktree.hostId && catalogLookups ? (
                  <ProviderScopeTable
                    hostId={worktree.hostId}
                    scope={{ repositoryId: worktree.repositoryId, worktreeId: worktree.id }}
                    inheritedEnabledLabel="repository"
                    resolutions={resolveProviderAccountsForScope(
                      hostWorktree,
                      hostRepository,
                      inventory ?? undefined,
                      catalogLookups.catalog,
                    )}
                    overridesAtScope={hostWorktree?.providerAccountOverrides ?? {}}
                    accountsById={catalogLookups.providerAccountsById}
                    providersById={catalogLookups.providersById}
                    commandsById={catalogLookups.commandsById}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Not associated with a host inventory.
                  </p>
                ),
            },
            {
              key: "settings",
              label: "Settings",
              content: (
                <div className="space-y-4">
                  <WorktreeDetailsCard
                    worktree={row}
                    repositoryName={repo?.name}
                    repoHrefBase="/repositories"
                    repoPath={repo?.url}
                    hostHrefBase="/hosts"
                  />
                  {worktree.hostId && hostWorktree ? (
                    <EditWorktreeForm
                      hostId={worktree.hostId}
                      repositoryId={worktree.repositoryId}
                      worktree={hostWorktree}
                      canWriteExecConfig={canWriteExecConfig}
                      hasInheritedExecutionConfig={hasInheritedExecutionConfig}
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
