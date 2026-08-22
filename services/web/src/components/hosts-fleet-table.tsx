import Link from "next/link";
import {
  DrainButton,
  OnlineStatusBadge,
  RelativeTime,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { HostWorktreeDetails, type FleetWorktree } from "./host-worktree-details.tsx";

export type FleetHost = {
  hostId: string;
  online: boolean;
  connectedAt?: string | null;
  gitReady?: boolean;
};

export type HostInventorySummary = {
  hostId: string;
  repositories?: unknown[];
};

export function HostsFleetTable({
  rows,
  inventoryById,
  worktreesByHost,
  canAddHost,
  canDrain = true,
}: {
  rows: FleetHost[];
  inventoryById: Map<string, HostInventorySummary>;
  worktreesByHost: Map<string, FleetWorktree[]>;
  canAddHost: boolean;
  canDrain?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Host</TableHead>
          <TableHead>Online</TableHead>
          <TableHead>Git</TableHead>
          <TableHead>Repos</TableHead>
          <TableHead>Host config</TableHead>
          <TableHead>Connected</TableHead>
          <TableHead>Worktrees</TableHead>
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
              <TableCell>{h.gitReady ? "Ready" : "Not ready"}</TableCell>
              <TableCell className="text-xs">{repoCount}</TableCell>
              <TableCell>{inventory ? "yes" : "no"}</TableCell>
              <TableCell
                className="whitespace-nowrap text-xs"
                data-pw={`host-connected-at-${h.hostId}`}
              >
                <RelativeTime value={h.connectedAt} label="Connected" />
              </TableCell>
              <TableCell>
                <HostWorktreeDetails
                  hostId={h.hostId}
                  worktrees={worktreesByHost.get(h.hostId) ?? []}
                />
              </TableCell>
              <TableCell>
                {canDrain ? (
                  <DrainButton hostId={h.hostId} size="sm" pw={`host-drain-${h.hostId}`} />
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="text-muted-foreground">
              {canAddHost
                ? "No hosts match filters. Add a host above or start a daemon."
                : "No hosts match filters."}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
