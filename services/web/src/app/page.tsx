import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  TipLink,
  TipText,
} from "@auto-harness/ui";

import { apiGet } from "../lib/api.ts";

export const dynamic = "force-dynamic";

type Session = { id: string; status: string; prompt?: string };
type Host = { hostId: string; online: boolean };

export default async function DashboardPage() {
  let sessions: Session[] = [];
  let hosts: Host[] = [];
  let error: string | null = null;
  try {
    const [s, h] = await Promise.all([
      apiGet<{ items: Session[] }>("/api/v1/sessions"),
      apiGet<{ items: Host[] }>("/api/v1/hosts"),
    ]);
    sessions = s.items ?? [];
    hosts = h.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const running = sessions.filter((x) => x.status === "running").length;
  const queued = sessions.filter((x) => x.status === "queued").length;
  const online = hosts.filter((x) => x.online).length;

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

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-red-50 p-3 text-sm text-red-900"
          data-pw="dashboard-api-error"
        >
          API unreachable ({error}). Start <code>pnpm local:api</code>.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3" data-pw="dashboard-stats">
        <Card data-pw="stat-running">
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Sessions currently executing on a host">Running</TipText>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold" data-pw="stat-running-value">
            {running}
          </CardContent>
        </Card>
        <Card data-pw="stat-queued">
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Sessions waiting for an available host worktree">Queued</TipText>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold" data-pw="stat-queued-value">
            {queued}
          </CardContent>
        </Card>
        <Card data-pw="stat-hosts-online">
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Hosts with a live connection / total known hosts (including offline slots)">
                Hosts online
              </TipText>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold" data-pw="stat-hosts-online-value">
            {online}/{hosts.length}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <TipText tip="Most recent sessions from the control plane">Recent sessions</TipText>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {sessions.slice(0, 8).map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/sessions/${encodeURIComponent(s.id)}`}
                className="font-mono hover:underline"
              >
                {s.id}
              </Link>
              <StatusBadge status={s.status} />
            </div>
          ))}
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sessions yet. Create your first session.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
