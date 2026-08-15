import { Suspense } from "react";
import Link from "next/link";
import {
  DrainButton,
  OnlineStatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { AddHostForm } from "../../components/add-host-form.tsx";
import { HostFilters } from "../../components/host-filters.tsx";
import {
  HostWorktreeDetails,
  type FleetWorktree,
} from "../../components/host-worktree-details.tsx";
import { apiGet } from "../../lib/api.ts";
import { parseHostListState } from "../../lib/url-state.ts";

export const dynamic = "force-dynamic";

type Host = {
  hostId: string;
  online: boolean;
  connectedAt?: string | null;
  commandProfiles?: string[];
  worktreeIds?: string[];
};

type HostInventorySummary = {
  hostId: string;
  commandProfiles?: Record<string, unknown>;
  repositories?: unknown[];
};

export default async function HostsPage({
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
  const filters = parseHostListState(sp);

  let hosts: Host[] = [];
  let inventories: HostInventorySummary[] = [];
  let worktrees: FleetWorktree[] = [];
  let error: string | null = null;
  try {
    const [h, inv, wt] = await Promise.all([
      apiGet<{ items: Host[] }>("/api/v1/hosts"),
      apiGet<{ items: HostInventorySummary[] }>("/api/v1/host-inventories"),
      apiGet<{ items: FleetWorktree[] }>("/api/v1/worktrees"),
    ]);
    hosts = h.items ?? [];
    inventories = inv.items ?? [];
    worktrees = wt.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const inventoryById = new Map(inventories.map((inv) => [inv.hostId, inv]));
  const worktreesByHost = Map.groupBy(worktrees, (worktree) => worktree.hostId);
  let rows = hosts;
  if (filters.online === "online") {
    rows = rows.filter((h) => h.online);
  } else if (filters.online === "offline") {
    rows = rows.filter((h) => !h.online);
  }

  return (
    <div className="space-y-6" data-pw="page-hosts">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="hosts-heading">
          Hosts
        </h2>
        <p className="text-sm text-muted-foreground">
          Add a host slot (host inventory), then run the daemon with that{" "}
          <code className="font-mono">HARNESS_HOST_ID</code>. Click a host below to attach
          repositories, manage worktrees, and configure Provider accounts.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-lg font-medium">Add host</h3>
        <AddHostForm />
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-medium">Fleet</h3>
        <Suspense fallback={null}>
          <HostFilters />
        </Suspense>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>hostId</TableHead>
              <TableHead>online</TableHead>
              <TableHead>profiles</TableHead>
              <TableHead>repos</TableHead>
              <TableHead>host config</TableHead>
              <TableHead>connected</TableHead>
              <TableHead>worktrees</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((h) => {
              const inventory = inventoryById.get(h.hostId);
              const repoCount = Array.isArray(inventory?.repositories)
                ? inventory.repositories.length
                : 0;
              return (
                <TableRow key={h.hostId} data-pw={`host-row-${h.hostId}`}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/hosts/${encodeURIComponent(h.hostId)}`}
                      className="hover:underline"
                      data-pw={`host-link-${h.hostId}`}
                    >
                      {h.hostId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <OnlineStatusBadge online={h.online} pw={`host-online-${h.hostId}`} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {JSON.stringify(h.commandProfiles ?? [])}
                  </TableCell>
                  <TableCell className="text-xs">{repoCount}</TableCell>
                  <TableCell>{inventory ? "yes" : "no"}</TableCell>
                  <TableCell
                    className="whitespace-nowrap text-xs"
                    data-pw={`host-connected-at-${h.hostId}`}
                  >
                    {h.connectedAt ? (
                      <time dateTime={h.connectedAt} title={h.connectedAt}>
                        {h.connectedAt}
                      </time>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <HostWorktreeDetails
                      hostId={h.hostId}
                      worktrees={worktreesByHost.get(h.hostId) ?? []}
                    />
                  </TableCell>
                  <TableCell>
                    <DrainButton hostId={h.hostId} size="sm" pw={`host-drain-${h.hostId}`} />
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground">
                  No hosts match filters. Add a host above or start a daemon.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
