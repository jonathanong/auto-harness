import { TipLink, TipText } from "@auto-harness/ui";

import {
  DashboardLive,
  type DashboardHost,
  type DashboardSession,
  type DashboardSnapshot,
  type DashboardWorktree,
  type SessionCount,
} from "../components/dashboard-live.tsx";
import { apiGet } from "../lib/api.ts";

export const dynamic = "force-dynamic";

async function getSessionCount(status: "running" | "queued"): Promise<SessionCount> {
  const page = await apiGet<{ items?: unknown[]; nextCursor?: string | null }>(
    `/api/v1/sessions?status=${status}&limit=100`,
  );
  return { count: page.items?.length ?? 0, atLimit: (page.nextCursor ?? null) !== null };
}

export default async function DashboardPage() {
  const initial: DashboardSnapshot = {
    hosts: [],
    sessions: [],
    worktrees: [],
    running: { count: 0, atLimit: false },
    queued: { count: 0, atLimit: false },
  };
  let error: string | null = null;
  try {
    const [sessions, hosts, worktrees, running, queued] = await Promise.all([
      apiGet<{ items: DashboardSession[] }>("/api/v1/sessions"),
      apiGet<{ items: DashboardHost[] }>("/api/v1/hosts"),
      apiGet<{ items: DashboardWorktree[] }>("/api/v1/worktrees"),
      getSessionCount("running"),
      getSessionCount("queued"),
    ]);
    initial.sessions = sessions.items ?? [];
    initial.hosts = hosts.items ?? [];
    initial.worktrees = worktrees.items ?? [];
    initial.running = running;
    initial.queued = queued;
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }

  return (
    <div className="space-y-6" data-pw="page-dashboard">
      <div className="flex items-center justify-between gap-4">
        <div>
          <TipText
            as="h2"
            className="cursor-help text-2xl font-semibold tracking-tight"
            tip="Live counts from the control plane API"
            pw="dashboard-heading"
          >
            Dashboard
          </TipText>
          <p className="text-sm text-muted-foreground">Control plane overview</p>
        </div>
        <TipLink
          href="/sessions/new"
          tip="Create a one-off session for a repository with a Provider or Command target"
          pw="dashboard-new-session"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          New session
        </TipLink>
      </div>
      <DashboardLive initial={initial} initialError={error} />
    </div>
  );
}
