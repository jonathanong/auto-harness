import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";

/** A smoke run uses a repository the operator already scoped and provisioned. */
export async function loadSmokeRepository(client, repositoryId) {
  try {
    return await client.request(`/repositories/${pathSegment(repositoryId, "repositoryId")}`);
  } catch (error) {
    if (error instanceof AutoHarnessError && error.status === 404) {
      throw new Error(`repository ${repositoryId} not found or outside this credential's scope`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Read-only preflight; the host must already own the selected attachment and worktree. */
export async function verifySmokeAttachment(client, hostId, repositoryId, repoPath) {
  const inventory = await client.request(`/hosts/${pathSegment(hostId, "hostId")}/inventory`);
  const attached = inventory.repositories?.find((entry) => entry.id === repositoryId);
  if (!attached) {
    throw new Error(`repository ${repositoryId} must already be attached to host ${hostId}`);
  }
  if (attached.path !== repoPath) {
    throw new Error(
      `repository ${repositoryId} is attached to host ${hostId} at ${attached.path}, not ${repoPath}`,
    );
  }
  if (!attached.worktrees?.length) {
    throw new Error(`repository ${repositoryId} has no configured worktree on host ${hostId}`);
  }
  return attached;
}
