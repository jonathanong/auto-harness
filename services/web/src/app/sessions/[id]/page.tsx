import Link from "next/link";
import { resolveSessionDetailTab, type SessionSummary } from "@auto-harness/ui";

import { SessionLiveDetail } from "../../../components/session-live-detail.tsx";
import { SessionLiveLogs } from "../../../components/session-live-logs.tsx";
import { apiGet } from "../../../lib/api.ts";
import { can, loadPrincipal } from "../../../lib/principal.ts";
import { MAX_LIVE_LOG_ENTRIES } from "../../../lib/live-session-logs.ts";
import { configuredCost, hasReportedUsage, type UsageAggregate } from "./session-usage-summary.ts";

export const dynamic = "force-dynamic";

type LogEntry = {
  timestampSeq: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};
export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const tab = resolveSessionDetailTab((await searchParams)?.tab);

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
      `/api/v1/sessions/${encodeURIComponent(id)}/logs?limit=${MAX_LIVE_LOG_ENTRIES}`,
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
  let hosts: Array<{ hostId: string; online: boolean }> = [];
  if (session.status === "running" && session.hostId) {
    try {
      hosts =
        (await apiGet<{ items: Array<{ hostId: string; online: boolean }> }>("/api/v1/hosts"))
          .items ?? [];
    } catch {
      /* live client refresh retries host state */
    }
  }

  const principal = await loadPrincipal();
  const canWrite = can(principal, "sessions:write");
  const createdBy = session.metadata?.createdBy;
  const canCancel =
    can(principal, "sessions:cancel-any") ||
    (canWrite && !!principal?.id && createdBy === principal.id);
  const canArchive = can(principal, "sessions:archive");

  return (
    <div data-pw="page-session-detail">
      <SessionLiveDetail
        initialSession={session}
        initialHosts={hosts}
        canCancel={canCancel}
        canResume={canWrite}
        canClone={canWrite}
        canArchive={canArchive}
        defaultTab={tab}
        detailsExtra={
          <div className="rounded-md border p-4" data-pw="session-usage-summary">
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
        }
      >
        <SessionLiveLogs
          sessionId={session.id}
          initialItems={logs}
          initialStatus={session.status}
        />
      </SessionLiveDetail>
    </div>
  );
}
