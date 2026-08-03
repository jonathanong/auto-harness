import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, StatusBadge, TipText } from "@auto-harness/ui";

import { DrainButton } from "../components/drain-button.tsx";
import { agentId, apiBase, apiGet } from "../lib/api.ts";

const CLICKABLE_CARD =
  "transition-colors hover:bg-muted/40 hover:border-foreground/20 cursor-pointer";

export const dynamic = "force-dynamic";

export default async function AgentStatusPage() {
  const id = agentId();

  let me: { agentId: string; online: boolean; commandProfiles?: string[] } | undefined;
  let worktreeCount = 0;
  let sessionCount = 0;
  let hasConfig = false;
  let error: string | null = null;

  try {
    const [agents, wts, sess, cfg] = await Promise.all([
      apiGet<{ items: Array<{ agentId: string; online: boolean; commandProfiles?: string[] }> }>(
        "/api/v1/agents",
      ),
      apiGet<{ items: Array<Record<string, unknown>> }>("/api/v1/worktrees"),
      apiGet<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(
        `/api/v1/sessions?limit=1&agentId=${encodeURIComponent(id)}`,
      ),
      fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(id)}/config`, { cache: "no-store" }),
    ]);
    me = agents.items?.find((a) => a.agentId === id);
    worktreeCount = (wts.items ?? []).filter((w) => w.agentId === id).length;
    sessionCount = (sess.items ?? []).length;
    hasConfig = cfg.ok;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6" data-pw="page-agent-status">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <TipText
            as="h2"
            className="cursor-help text-2xl font-semibold tracking-tight"
            tip="This page is bound to HARNESS_AGENT_ID (or default local-1)"
            pw="agent-status-id"
          >
            {id}
          </TipText>
          <p className="text-sm text-muted-foreground">
            Status overview. Manage repos, worktrees, and sessions from the nav.
          </p>
        </div>
        <DrainButton agentId={id} />
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Live WebSocket connection to the control plane">Online</TipText>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={String(me?.online ?? false)} />
          </CardContent>
        </Card>
        <Link href="/repositories" data-pw="stat-host-config-link">
          <Card className={CLICKABLE_CARD}>
            <CardHeader>
              <CardTitle className="text-base">
                <TipText tip="Whether host inventory exists for this agentId">Host config</TipText>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {hasConfig ? "present" : "missing — add under Repositories"}
            </CardContent>
          </Card>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Command profile names advertised when the host registers">
                Profiles
              </TipText>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs font-mono">
            {JSON.stringify(me?.commandProfiles ?? [])}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/worktrees" data-pw="stat-worktrees-link">
          <Card className={CLICKABLE_CARD}>
            <CardHeader>
              <CardTitle className="text-base">Worktrees (live)</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold" data-pw="stat-worktrees">
              {worktreeCount}
            </CardContent>
          </Card>
        </Link>
        <Link href="/sessions" data-pw="stat-sessions-link">
          <Card className={CLICKABLE_CARD}>
            <CardHeader>
              <CardTitle className="text-base">Recent page sample</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold" data-pw="stat-sessions-sample">
              {sessionCount}
              <span className="ml-2 text-sm font-normal text-muted-foreground">on first page</span>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
