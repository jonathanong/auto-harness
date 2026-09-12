import Link from "next/link";

import { DeleteWorkspacePoolButton } from "../../../components/delete-workspace-pool-button.tsx";
import {
  WorkspacePoolForm,
  type WorkspacePoolConfig,
} from "../../../components/workspace-pool-form.tsx";
import { apiGet } from "../../../lib/api.ts";
import { can, loadPrincipal } from "../../../lib/principal.ts";

export const dynamic = "force-dynamic";

export default async function WorkspacePoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const canWrite = can(await loadPrincipal(), "fleet:exec-config");
  let pool: WorkspacePoolConfig | null = null;
  if (canWrite) {
    try {
      pool = await apiGet<WorkspacePoolConfig>(
        `/api/v1/workspace-pools/${encodeURIComponent(id)}/exec-config`,
      );
    } catch {
      /* shown below */
    }
  }
  if (!pool)
    return (
      <div className="space-y-3" data-pw="page-workspace-pool-not-found">
        <Link href="/workspace-pools" className="text-sm text-muted-foreground hover:underline">
          ← Back to workspace pools
        </Link>
        <p className="text-sm text-muted-foreground">
          {canWrite
            ? "Workspace pool not found."
            : "Viewing workspace setup profiles requires fleet:exec-config."}
        </p>
      </div>
    );
  return (
    <div className="space-y-5" data-pw="page-workspace-pool-detail">
      <Link href="/workspace-pools" className="text-sm text-muted-foreground hover:underline">
        ← Back to workspace pools
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{pool.name}</h2>
          <p className="text-sm text-muted-foreground">
            Edit trusted setup profiles and cleanup policy.
          </p>
        </div>
        <DeleteWorkspacePoolButton poolId={pool.id} />
      </div>
      <WorkspacePoolForm pool={pool} />
    </div>
  );
}
