import { Suspense } from "react";
import {
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { AddAgentForm } from "../../components/add-agent-form.tsx";
import { AgentFilters } from "../../components/agent-filters.tsx";
import { AgentDrainButton } from "../../components/agent-drain-button.tsx";
import { apiGet } from "../../lib/api.ts";
import { parseAgentListState } from "../../lib/url-state.ts";

export const dynamic = "force-dynamic";

type Agent = {
  agentId: string;
  online: boolean;
  commandProfiles?: string[];
  worktreeIds?: string[];
};

type Host = {
  agentId: string;
  commandProfiles?: Record<string, unknown>;
  repositories?: unknown[];
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      sp.set(k, v);
    }
  }
  const filters = parseAgentListState(sp);

  let agents: Agent[] = [];
  let hosts: Host[] = [];
  let error: string | null = null;
  try {
    const [a, h] = await Promise.all([
      apiGet<{ items: Agent[] }>("/api/v1/agents"),
      apiGet<{ items: Host[] }>("/api/v1/agent-hosts"),
    ]);
    agents = a.items ?? [];
    hosts = h.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const hostById = new Map(hosts.map((h) => [h.agentId, h]));
  let rows = agents;
  if (filters.online === "online") {
    rows = rows.filter((a) => a.online);
  } else if (filters.online === "offline") {
    rows = rows.filter((a) => !a.online);
  }

  return (
    <div className="space-y-6" data-pw="page-agents">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="agents-heading">
          Agents
        </h2>
        <p className="text-sm text-muted-foreground">
          Add an agent slot (host inventory), then run the daemon with that{" "}
          <code className="font-mono">HARNESS_AGENT_ID</code>. Configure repos and worktrees on the
          agent pane (<code className="font-mono">:7423</code>).
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-lg font-medium">Add agent</h3>
        <AddAgentForm />
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-medium">Fleet</h3>
        <Suspense fallback={null}>
          <AgentFilters />
        </Suspense>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>agentId</TableHead>
              <TableHead>online</TableHead>
              <TableHead>profiles</TableHead>
              <TableHead>repos</TableHead>
              <TableHead>host config</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => {
              const host = hostById.get(a.agentId);
              const repoCount = Array.isArray(host?.repositories) ? host.repositories.length : 0;
              return (
                <TableRow key={a.agentId} data-pw={`agent-row-${a.agentId}`}>
                  <TableCell className="font-mono text-xs">{a.agentId}</TableCell>
                  <TableCell>
                    <StatusBadge status={String(a.online)} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {JSON.stringify(a.commandProfiles ?? [])}
                  </TableCell>
                  <TableCell className="text-xs">{repoCount}</TableCell>
                  <TableCell>{host ? "yes" : "no"}</TableCell>
                  <TableCell>
                    <AgentDrainButton agentId={a.agentId} />
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No agents match filters. Add an agent above or start a daemon.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
