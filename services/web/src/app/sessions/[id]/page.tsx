import Link from "next/link";
import { SessionActions, SessionDetail, SessionLogs, type SessionSummary } from "@auto-harness/ui";

import { apiGet } from "../../../lib/api.ts";
import { configuredCost, hasReportedUsage, type UsageAggregate } from "./session-usage-summary.ts";

export const dynamic = "force-dynamic";

type LogEntry = { seq: number; stream: string; content: string; timestamp: string };
export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let session: SessionSummary | undefined;
  try {
    session = await apiGet<SessionSummary>(`/api/v1/sessions/${encodeURIComponent(id)}`);
  } catch {
    /* treated as not found below */
  }

  if (!session) {
    return (
      <div className="space-y-4" data-pw="page-session-detail-not-found">
        <Link href="/sessions" className="text-sm text-muted-foreground hover:underline">
          ← Back to sessions
        </Link>
        <p className="text-sm text-muted-foreground">
          No session <code className="font-mono">{id}</code> found.
        </p>
      </div>
    );
  }

  let logs: LogEntry[] = [];
  try {
    const data = await apiGet<{ items: LogEntry[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/logs?limit=10000`,
    );
    logs = data.items ?? [];
  } catch {
    /* ignore — logs section stays empty */
  }
  let usage: UsageAggregate | null = null;
  try {
    usage = (
      await apiGet<{ aggregate: UsageAggregate }>(
        `/api/v1/sessions/${encodeURIComponent(id)}/usage`,
      )
    ).aggregate;
  } catch {
    /* usage is optional for older hosts and sessions */
  }

  return (
    <div data-pw="page-session-detail">
      <SessionDetail
        session={session}
        breadcrumbs={[{ label: "Sessions", href: "/sessions" }, { label: session.id }]}
        actions={<SessionActions sessionId={session.id} status={session.status} />}
        repoHrefBase="/repositories"
        hostHrefBase="/hosts"
        worktreeHrefBase="/worktrees"
      >
        <div className="mb-4 rounded-md border p-4" data-pw="session-usage-summary">
          <h3 className="text-sm font-medium">Session usage</h3>
          {hasReportedUsage(usage) ? (
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Input tokens</dt>
                <dd data-pw="session-usage-input">{usage.inputTokens}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Output tokens</dt>
                <dd data-pw="session-usage-output">{usage.outputTokens}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Total tokens</dt>
                <dd data-pw="session-usage-total">{usage.totalTokens}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Configured cost</dt>
                <dd data-pw="session-usage-cost">{configuredCost(usage)}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No CLI usage reported.</p>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Logs</h3>
          <SessionLogs items={logs} />
        </div>
      </SessionDetail>
    </div>
  );
}
