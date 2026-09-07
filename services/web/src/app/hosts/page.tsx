import { Suspense } from "react";
import { Alert, CursorPagination } from "@auto-harness/ui";

import { AddHostForm } from "../../components/add-host-form.tsx";
import { HostFilters } from "../../components/host-filters.tsx";
import type { FleetWorktree } from "../../components/host-worktree-details.tsx";
import {
  HostsFleetTable,
  type FleetHost,
  type HostInventorySummary,
} from "../../components/hosts-fleet-table.tsx";
import { apiGet } from "../../lib/api.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";
import { parseHostListState } from "../../lib/url-state.ts";

export const dynamic = "force-dynamic";

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
  const cursor = typeof raw.cursor === "string" ? raw.cursor : null;
  const principal = await loadPrincipal();
  const canWriteInventory = can(principal, "fleet:inventory");
  const canDrain = can(principal, "fleet:drain");

  let hosts: FleetHost[] = [];
  let hostsNextCursor: string | null = null;
  let inventories: HostInventorySummary[] = [];
  let worktrees: FleetWorktree[] = [];
  let error: string | null = null;
  const onlineQuery =
    filters.online === "online" || filters.online === "offline" ? `&online=${filters.online}` : "";
  const hostsPath = `/api/v1/hosts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${onlineQuery}`;
  try {
    const [h, inv] = await Promise.all([
      apiGet<{ items: FleetHost[]; nextCursor?: string | null }>(hostsPath),
      apiGet<{ items: HostInventorySummary[] }>("/api/v1/host-inventories?limit=100"),
    ]);
    hosts = h.items ?? [];
    hostsNextCursor = h.nextCursor ?? null;
    inventories = inv.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    const response = await apiGet<{ items: FleetWorktree[] }>("/api/v1/worktrees?limit=100");
    worktrees = response.items ?? [];
  } catch {
    // Worktree details are auxiliary; keep host management available if this read fails.
  }

  const inventoryById = new Map(inventories.map((inv) => [inv.hostId, inv]));
  const worktreesByHost = Map.groupBy(worktrees, (worktree) => worktree.hostId);

  return (
    <div className="space-y-6" data-pw="page-hosts">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="hosts-heading">
          Hosts
        </h2>
        <p className="text-sm text-muted-foreground">
          {canWriteInventory ? (
            <>
              Add a host slot (host inventory), then run the daemon with that{" "}
              <code className="font-mono">HARNESS_HOST_ID</code>. Click a host below to attach
              repositories, manage worktrees, and configure Provider accounts.
            </>
          ) : (
            <>
              Use an existing host slot to attach repositories, manage worktrees, and configure
              Provider accounts.
            </>
          )}
        </p>
      </div>

      {canWriteInventory ? (
        <section className="space-y-2">
          <h3 className="text-lg font-medium">Add host</h3>
          <AddHostForm />
        </section>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-lg font-medium">Fleet</h3>
        <Suspense fallback={null}>
          <HostFilters />
        </Suspense>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        {hosts.some((host) => !host.online) ? (
          <Alert variant="info" role="note" data-pw="hosts-retained-data-notice">
            Host slots persist in Foundation tables across teardown (not purge), so a restore can
            show leftover offline slots. Delete unused hosts, or purge the environment to wipe them.
          </Alert>
        ) : null}
        <HostsFleetTable
          rows={hosts}
          inventoryById={inventoryById}
          worktreesByHost={worktreesByHost}
          canAddHost={canWriteInventory}
          canDrain={canDrain}
        />
        <CursorPagination
          nextHref={
            hostsNextCursor
              ? `/hosts?${new URLSearchParams({
                  ...Object.fromEntries(sp.entries()),
                  cursor: hostsNextCursor,
                }).toString()}`
              : null
          }
        />
      </section>
    </div>
  );
}
