import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";

const MAX_ATTEMPTS = 3;

/** GET the current inventory record for a host — shared by the pre-write extraction, the
 * dry-run preview, and every retry's re-read, so all three see the same document. */
function getInventory(client, hostId) {
  return client.request(`/hosts/${pathSegment(hostId, "hostId")}/inventory`);
}

/** Finds the repository by id. By default throws (exit 1) listing what is actually attached;
 * pass `required: false` to get `null` instead — used on a retry's re-read, where the
 * repository being gone already means someone else's write reached the same goal. */
function extractRepository(record, hostId, repositoryId, { required = true } = {}) {
  const repositories = record.repositories ?? [];
  const repository = repositories.find((repo) => repo.id === repositoryId);
  if (!repository) {
    if (!required) return null;
    const attached = repositories.map((repo) => repo.id);
    throw new Error(
      `repository ${repositoryId} is not attached to host ${hostId}; attached repositories: ` +
        (attached.length > 0 ? attached.join(", ") : "(none)"),
    );
  }
  const worktreeIds = (repository.worktrees ?? []).map((worktree) => worktree.id);
  const remaining = repositories.filter((repo) => repo.id !== repositoryId);
  return { repository, worktreeIds, remaining };
}

/**
 * Detaches one repository from a host's inventory as a safe read-modify-write, mirroring
 * `attach-repository.js`'s attach flow: GET the full record, remove only the target repository
 * (its worktrees go with it — that is a projection of the repository, not a separate thing to
 * delete), and PUT back everything else — including `providerAccounts` — exactly as read,
 * keeping the read `version`. On a 409 (someone else wrote first) this re-reads and re-applies,
 * up to `MAX_ATTEMPTS` PUTs total; any other status is not retried.
 *
 * `{ dryRun: true }` does the same read and lookup but returns before ever writing, so
 * `host repo rm --dry-run` and a real detach can never disagree about what would be removed.
 * Exported (rather than folded into the command) because `host smoke` reuses this exact logic
 * for its own teardown.
 */
export async function detachRepository(client, hostId, repositoryId, { dryRun = false } = {}) {
  const record = await getInventory(client, hostId);
  const removal = extractRepository(record, hostId, repositoryId);
  if (dryRun) {
    return {
      detached: false,
      dryRun: true,
      convergedElsewhere: false,
      hostId,
      repository: removal.repository,
      worktreeIds: removal.worktreeIds,
      fromVersion: record.version ?? 0,
    };
  }
  return removeWithRetry(client, hostId, repositoryId, record, removal);
}

async function removeWithRetry(client, hostId, repositoryId, record, removal) {
  let currentRecord = record;
  let current = removal;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const fromVersion = currentRecord.version ?? 0;
    const document = { ...currentRecord, repositories: current.remaining, version: fromVersion };
    try {
      const result = await client.request(`/hosts/${pathSegment(hostId, "hostId")}/inventory`, {
        method: "PUT",
        body: JSON.stringify(document),
      });
      return {
        detached: true,
        dryRun: false,
        convergedElsewhere: false,
        hostId,
        repository: current.repository,
        worktreeIds: current.worktreeIds,
        fromVersion,
        toVersion: result?.version,
      };
    } catch (error) {
      const conflict = error instanceof AutoHarnessError && error.status === 409;
      if (!conflict) throw error;
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `inventory for host ${hostId} kept changing; gave up after ${MAX_ATTEMPTS} attempts`,
          { cause: error },
        );
      }
      currentRecord = await getInventory(client, hostId);
      const next = extractRepository(currentRecord, hostId, repositoryId, { required: false });
      if (!next) {
        return {
          detached: true,
          dryRun: false,
          convergedElsewhere: true,
          hostId,
          repository: current.repository,
          worktreeIds: current.worktreeIds,
          toVersion: currentRecord.version,
        };
      }
      current = next;
    }
  }
  /* v8 ignore next 2 -- the loop above always returns or throws before falling out */
  return undefined;
}
