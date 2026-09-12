import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";
import { thrownMessage } from "@auto-harness/shared";

import {
  WorkspacePoolForm,
  type WorkspacePoolConfig,
} from "../../components/workspace-pool-form.tsx";
import { apiGet } from "../../lib/api.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";

export const dynamic = "force-dynamic";

type WorkspacePoolSummary = Omit<WorkspacePoolConfig, "setupProfiles"> & {
  setupProfiles: Array<Pick<WorkspacePoolConfig["setupProfiles"][number], "id" | "name">>;
};

export default async function WorkspacePoolsPage() {
  let pools: WorkspacePoolSummary[] = [];
  let error: string | null = null;
  const canWrite = can(await loadPrincipal(), "fleet:exec-config");
  try {
    pools =
      (await apiGet<{ items?: WorkspacePoolSummary[] }>("/api/v1/workspace-pools")).items ?? [];
  } catch (cause) {
    error = thrownMessage(cause);
  }

  return (
    <div className="space-y-6" data-pw="page-workspace-pools">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="workspace-pools-heading">
          Workspace pools
        </h2>
        <p className="text-sm text-muted-foreground">
          Non-git host workspaces. Setup profiles are trusted admin configuration, never raw session
          input.
        </p>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>name</TableHead>
            <TableHead>setup profiles</TableHead>
            <TableHead>default cleanup</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pools.map((pool) => (
            <TableRow key={pool.id} data-pw={`workspace-pool-row-${pool.id}`}>
              <TableCell>
                <Link
                  href={`/workspace-pools/${encodeURIComponent(pool.id)}`}
                  className="hover:underline"
                  data-pw={`workspace-pool-link-${pool.id}`}
                >
                  {pool.name}
                </Link>
              </TableCell>
              <TableCell>
                {pool.setupProfiles.map((profile) => profile.name).join(", ") || "—"}
              </TableCell>
              <TableCell>{pool.destroyWorkspaceAfter ? "destroy" : "retain"}</TableCell>
            </TableRow>
          ))}
          {pools.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                No workspace pools configured.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {canWrite ? (
        <div className="space-y-3 border-t pt-5">
          <h3 className="text-lg font-medium">Create workspace pool</h3>
          <WorkspacePoolForm />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Workspace-pool changes require <code>fleet:exec-config</code>.
        </p>
      )}
    </div>
  );
}
