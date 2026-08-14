import Link from "next/link";
import { SessionLogs, type SessionSummary } from "@auto-harness/ui";

import { SessionLiveDetail } from "../../../components/session-live-detail.tsx";
import { apiGet } from "../../../lib/api.ts";

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

  return (
    <div data-pw="page-session-detail">
      <SessionLiveDetail initialSession={session}>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Logs</h3>
          <SessionLogs items={logs} />
        </div>
      </SessionLiveDetail>
    </div>
  );
}
