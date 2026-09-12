import { thrownMessage } from "@auto-harness/shared";
import { TipText } from "@auto-harness/ui";

import {
  DashboardLive,
  type DashboardHost,
  type DashboardSession,
  type DashboardSnapshot,
  type DashboardWorktree,
  type SessionCount,
} from "../components/dashboard-live.tsx";
import { apiGet, apiGetFirstPageWithItems } from "../lib/api.ts";

export const dynamic = "force-dynamic";

async function getSessionCount(status: "running" | "queued"): Promise<SessionCount> {
  const page = await apiGetFirstPageWithItems<unknown>(
    `/api/v1/sessions?status=${status}&limit=100`,
  );
  return { count: page.items.length, atLimit: page.nextCursor !== null };
}

export default async function DashboardPage() {
  const initial: DashboardSnapshot = {
    hosts: [],
    sessions: [],
    worktrees: [],
    hostsAtLimit: false,
    worktreesAtLimit: false,
    running: { count: 0, atLimit: false },
    queued: { count: 0, atLimit: false },
  };
  let error: string | null = null;
  try {
    const [sessions, hosts, worktrees, running, queued] = await Promise.all([
      apiGetFirstPageWithItems<DashboardSession>("/api/v1/sessions?limit=50"),
      apiGet<{ items: DashboardHost[]; nextCursor?: string | null }>("/api/v1/hosts?limit=100"),
      apiGet<{ items: DashboardWorktree[]; nextCursor?: string | null }>(
        "/api/v1/worktrees?limit=100",
      ),
      getSessionCount("running"),
      getSessionCount("queued"),
    ]);
    initial.sessions = sessions.items;
    initial.hosts = hosts.items ?? [];
    initial.worktrees = worktrees.items ?? [];
    initial.hostsAtLimit = (hosts.nextCursor ?? null) !== null;
    initial.worktreesAtLimit = (worktrees.nextCursor ?? null) !== null;
    initial.running = running;
    initial.queued = queued;
  } catch (reason) {
    error = thrownMessage(reason);
  }

  return (
    <div className="space-y-6" data-pw="page-dashboard">
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
      <DashboardLive initial={initial} initialError={error} />
    </div>
  );
}
