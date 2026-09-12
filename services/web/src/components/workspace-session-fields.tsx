"use client";

import { Label } from "@auto-harness/ui";

export type WorkspacePoolOption = {
  id: string;
  name: string;
  setupProfiles: Array<{ id: string; name: string }>;
  defaultSetupProfileId?: string;
  destroyWorkspaceAfter?: boolean;
};

export function WorkspaceSessionFields({
  pools,
  poolId,
  onPoolIdChange,
}: {
  pools: WorkspacePoolOption[];
  poolId: string;
  onPoolIdChange: (poolId: string) => void;
}) {
  const pool = pools.find((candidate) => candidate.id === poolId);
  return (
    <div className="space-y-3 rounded-md border p-3" data-pw="create-session-workspace-fields">
      <div className="space-y-1">
        <Label htmlFor="workspacePoolId" tip="A host-attached, non-git workspace pool">
          Workspace pool
        </Label>
        <select
          id="workspacePoolId"
          name="workspacePoolId"
          required
          value={poolId}
          onChange={(event) => onPoolIdChange(event.currentTarget.value)}
          data-pw="create-session-workspace-pool"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">Select a workspace pool</option>
          {pools.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="setupProfileId"
          tip="Trusted setup is selected by profile; session forms never accept a raw script"
        >
          Setup profile
        </Label>
        <select
          id="setupProfileId"
          name="setupProfileId"
          defaultValue=""
          key={pool?.id ?? "none"}
          data-pw="create-session-workspace-profile"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">Use the pool default</option>
          {pool?.setupProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="destroyWorkspaceAfter"
          tip="Leave as the pool policy unless this session needs a one-off override"
        >
          Cleanup after session
        </Label>
        <select
          id="destroyWorkspaceAfter"
          name="destroyWorkspaceAfter"
          defaultValue="inherit"
          data-pw="create-session-workspace-cleanup"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="inherit">
            Use pool policy ({pool?.destroyWorkspaceAfter ? "destroy" : "retain"})
          </option>
          <option value="true">Destroy and recreate this workspace</option>
          <option value="false">Retain this workspace</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Workspace sessions skip Git checkout and worktree labels. Setup scripts are configured only
        on the workspace pool.
      </p>
    </div>
  );
}
