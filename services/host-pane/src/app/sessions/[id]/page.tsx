import Link from "next/link";
import { SectionError, SessionTerminalViewer, type SessionSummary } from "@auto-harness/ui";

import { SessionLiveDetail } from "../../../components/session-live-detail.tsx";
import { ApiError, apiGet } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";

type LogEntry = {
  timestampSeq: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let session: SessionSummary | undefined;
  let sessionError: string | null = null;
  try {
    session = await apiGet<SessionSummary>(`/api/v1/sessions/${encodeURIComponent(id)}`);
  } catch (error) {
    // A 404 genuinely means the session doesn't exist. Anything else is a real
    // failure and must not be reported to the user as "no session found".
    if (!(error instanceof ApiError && error.status === 404)) {
      sessionError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!session) {
    return (
      <div className="space-y-4" data-pw="page-session-detail-not-found">
        <Link href="/sessions" className="text-sm text-muted-foreground hover:underline">
          ← Back to sessions
        </Link>
        {sessionError ? (
          <SectionError
            resource={`session ${id}`}
            message={sessionError}
            selector="session-detail-lookup"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No session <code className="font-mono">{id}</code> found.
          </p>
        )}
      </div>
    );
  }

  let logs: LogEntry[] = [];
  let logsError: string | null = null;
  try {
    const data = await apiGet<{ items: LogEntry[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/logs?limit=10000`,
    );
    logs = data.items ?? [];
  } catch (error) {
    logsError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div data-pw="page-session-detail">
      <SessionLiveDetail initialSession={session}>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Logs</h3>
          {logsError ? (
            <SectionError resource="session logs" message={logsError} selector="session-logs" />
          ) : (
            <SessionTerminalViewer sessionId={id} items={logs} />
          )}
        </div>
      </SessionLiveDetail>
    </div>
  );
}
