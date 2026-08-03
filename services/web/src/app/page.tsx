import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, StatusBadge } from "@auto-harness/ui";

import { apiGet } from "../lib/api.ts";

export const dynamic = "force-dynamic";

type Session = { id: string; status: string; prompt?: string };
type Agent = { agentId: string; online: boolean };

export default async function DashboardPage() {
  let sessions: Session[] = [];
  let agents: Agent[] = [];
  let error: string | null = null;
  try {
    const [s, a] = await Promise.all([
      apiGet<{ items: Session[] }>("/api/v1/sessions"),
      apiGet<{ items: Agent[] }>("/api/v1/agents"),
    ]);
    sessions = s.items ?? [];
    agents = a.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const running = sessions.filter((x) => x.status === "running").length;
  const queued = sessions.filter((x) => x.status === "queued").length;
  const online = agents.filter((x) => x.online).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">Control plane overview</p>
        </div>
        <Link
          href="/sessions/new"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          New session
        </Link>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-red-50 p-3 text-sm text-red-900">
          API unreachable ({error}). Start <code>pnpm local:api</code>.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Running</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold">{running}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Queued</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold">{queued}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agents online</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold">
            {online}/{agents.length}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {sessions.slice(0, 8).map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/sessions?q=${encodeURIComponent(s.id)}`}
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
