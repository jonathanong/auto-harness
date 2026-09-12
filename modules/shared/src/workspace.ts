/** A host-local directory that can execute a non-git workspace session. */
export type WorkspaceSlot = {
  id: string;
  name: string;
  path: string;
};

/** DynamoDB sort keys are limited to 1,024 UTF-8 bytes. */
export const MAX_WORKSPACE_SLOT_ID_BYTES = 1_024;

/** Shared UTF-8 byte-length check for workspace-slot sort-key IDs. */
export function workspaceSlotIdByteLengthError(id: string): string | null {
  if (new TextEncoder().encode(id).length > MAX_WORKSPACE_SLOT_ID_BYTES) {
    return `workspace slot id must be at most ${MAX_WORKSPACE_SLOT_ID_BYTES} bytes`;
  }
  return null;
}

/** A host's attachment to a control-plane workspace pool. */
export type WorkspacePoolAttachment = {
  workspacePoolId: string;
  /** Slots intentionally expose only identity and path; setup belongs to a profile. */
  slots: WorkspaceSlot[];
};

/** A trusted, persisted setup profile selected by id at session admission time. */
export type WorkspaceSetupProfile = {
  id: string;
  name: string;
  /** Trusted profile script; this is never accepted on a session input. */
  script: string;
};

/** Workspace-only fields accepted by session creation. */
export type WorkspaceSessionInput = {
  repositoryId: null;
  workspacePoolId: string;
  setupProfileId?: string;
  destroyWorkspaceAfter?: boolean;
};
