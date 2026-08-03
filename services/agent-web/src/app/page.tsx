import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { DrainButton } from "../components/drain-button.tsx";
import { TipText } from "../components/tip-text.tsx";
import { agentId, apiBase, apiGet } from "../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function AgentStatusPage() {
  const id = agentId();

  let me: { agentId: string; online: boolean; commandProfiles?: string[] } | undefined;
  let worktrees: Array<Record<string, unknown>> = [];
  let sessions: Array<Record<string, unknown>> = [];
  let hasConfig = false;
  let error: string | null = null;

  try {
    const [agents, wts, sess, cfg] = await Promise.all([
      apiGet<{ items: Array<{ agentId: string; online: boolean; commandProfiles?: string[] }> }>(
        "/api/v1/agents",
      ),
      apiGet<{ items: Array<Record<string, unknown>> }>("/api/v1/worktrees"),
      apiGet<{ items: Array<Record<string, unknown>> }>("/api/v1/sessions"),
      fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(id)}/config`, { cache: "no-store" }),
    ]);
    me = agents.items?.find((a) => a.agentId === id);
    worktrees = (wts.items ?? []).filter((w) => w.agentId === id);
    sessions = (sess.items ?? []).filter((s) => s.agentId === id).slice(0, 20);
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
            Agent pane — control plane is on :7421. Register with env only, then{" "}
            <a className="underline" href="/config">
              add local repos
            </a>
            .
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
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Whether host inventory exists for this agentId">Host config</TipText>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {hasConfig ? "present" : "missing — set under Host config"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <TipText tip="Command profile names advertised when the agent registers">
                Profiles
              </TipText>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs font-mono">
            {JSON.stringify(me?.commandProfiles ?? [])}
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-2 text-lg font-medium">
          <TipText tip="Worktrees registered for this agent (online/offline reflects scheduling)">
            Worktrees
          </TipText>
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>id</TableHead>
              <TableHead>repo</TableHead>
              <TableHead>path</TableHead>
              <TableHead>status</TableHead>
              <TableHead>online</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {worktrees.map((w) => (
              <TableRow key={String(w.id)}>
                <TableCell className="font-mono text-xs">{String(w.id)}</TableCell>
                <TableCell>{String(w.repositoryId ?? "")}</TableCell>
                <TableCell className="max-w-xs truncate text-xs">{String(w.path ?? "")}</TableCell>
                <TableCell>
                  <StatusBadge status={String(w.status ?? "")} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={String(w.online ?? false)} />
                </TableCell>
              </TableRow>
            ))}
            {worktrees.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No worktrees for this agent.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <div>
        <h3 className="mb-2 text-lg font-medium">
          <TipText tip="Recent sessions assigned to this agentId">Recent sessions</TipText>
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>id</TableHead>
              <TableHead>status</TableHead>
              <TableHead>profile</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={String(s.id)}>
                <TableCell className="font-mono text-xs">{String(s.id)}</TableCell>
                <TableCell>
                  <StatusBadge status={String(s.status ?? "")} />
                </TableCell>
                <TableCell>{String(s.commandProfile ?? "")}</TableCell>
              </TableRow>
            ))}
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
                  No sessions on this agent yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
