import type { ControlPlaneState } from "./control-plane-state.ts";
import * as pools from "./control-plane-workspace-pools.ts";

export class ControlPlaneWorkspacesService {
  readonly state: ControlPlaneState;

  constructor(state: ControlPlaneState) {
    this.state = state;
  }

  createWorkspacePool(input: pools.WorkspacePoolInput) {
    return pools.createWorkspacePool(this.state, input);
  }
  createWorkspacePoolDurable(input: pools.WorkspacePoolInput) {
    return pools.createWorkspacePoolDurable(this.state, input);
  }
  listWorkspacePools() {
    return pools.listWorkspacePools(this.state);
  }
  listWorkspacePoolsPublic() {
    return pools.listWorkspacePoolsPublic(this.state);
  }
  listWorkspacePoolsDurable() {
    return pools.listWorkspacePoolsDurable(this.state);
  }
  listWorkspacePoolSummariesDurable() {
    return pools.listWorkspacePoolSummariesDurable(this.state);
  }
  listWorkspacePoolsPublicDurable() {
    return pools.listWorkspacePoolsPublicDurable(this.state, () =>
      this.listWorkspacePoolsDurable(),
    );
  }
  getWorkspacePoolDurable(id: string) {
    return pools.getWorkspacePoolDurable(this.state, id);
  }
  getWorkspacePoolPublicDurable(id: string) {
    return pools.getWorkspacePoolPublicDurable(this.state, id);
  }
  updateWorkspacePool(id: string, patch: Partial<Omit<pools.WorkspacePoolInput, "id">>) {
    return pools.updateWorkspacePool(this.state, id, patch);
  }
  updateWorkspacePoolDurable(id: string, patch: Partial<Omit<pools.WorkspacePoolInput, "id">>) {
    return pools.updateWorkspacePoolDurable(this.state, id, patch);
  }
  deleteWorkspacePoolDurable(id: string) {
    return pools.deleteWorkspacePoolDurable(this.state, id);
  }
}
