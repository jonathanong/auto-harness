import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";

const MAX_ATTEMPTS = 3;

/** GET the current inventory record for a host — shared by the pre-write "already attached"
 * check, the dry-run preview, and every retry's re-read, so all three see the same document. */
function getInventory(client, hostId) {
  return client.request(`/hosts/${pathSegment(hostId, "hostId")}/inventory`);
}

function findAttachedRepository(record, repositoryId) {
  return (record.repositories ?? []).find((repo) => repo.id === repositoryId);
}

/**
 * Attaches `entry` (an inventory repository entry — see `parseWorktreeFlags` and
 * `host-repo-add.js` for how it is built) to a host's inventory as a safe read-modify-write,
 * mirroring `host-repo-rm.js`'s remove flow: GET the full record, add only the new entry to
 * `repositories`, and PUT back everything else — including `providerAccounts` — exactly as
 * read, keeping the read `version`. A repository already attached to the host is never
 * overwritten; the caller must remove it first. On a 409 (someone else wrote first) this
 * re-reads and re-applies, up to `MAX_ATTEMPTS` PUTs total; any other status is not retried.
 *
 * `{ dryRun: true }` does the same read and "already attached" check but returns before ever
 * writing, so `host repo add --dry-run` and a real attach can never disagree about whether the
 * attach would succeed. Exported (rather than folded into the command) because a later
 * `host smoke` command reuses this exact logic.
 */
export async function attachRepository(client, hostId, entry, { dryRun = false } = {}) {
  const record = await getInventory(client, hostId);
  const existing = findAttachedRepository(record, entry.id);
  if (existing) {
    throw new Error(
      `repository ${entry.id} is already attached to host ${hostId} at ${existing.path}`,
    );
  }
  if (dryRun) {
    return {
      attached: false,
      dryRun: true,
      convergedElsewhere: false,
      hostId,
      repository: entry,
      worktreeIds: entry.worktrees.map((worktree) => worktree.id),
      fromVersion: record.version ?? 0,
    };
  }
  return attachWithRetry(client, hostId, entry, record);
}

async function attachWithRetry(client, hostId, entry, record) {
  let currentRecord = record;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const fromVersion = currentRecord.version ?? 0;
    const document = {
      ...currentRecord,
      repositories: [...(currentRecord.repositories ?? []), entry],
      version: fromVersion,
    };
    try {
      const result = await client.request(`/hosts/${pathSegment(hostId, "hostId")}/inventory`, {
        method: "PUT",
        body: JSON.stringify(document),
      });
      return {
        attached: true,
        dryRun: false,
        convergedElsewhere: false,
        hostId,
        repository: entry,
        worktreeIds: entry.worktrees.map((worktree) => worktree.id),
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
      const convergence = reconcileConflict(currentRecord, hostId, entry);
      if (convergence) return convergence;
    }
  }
  /* v8 ignore next 2 -- the loop above always returns or throws before falling out */
  return undefined;
}

/** After a 409, someone else changed the inventory first. If they attached this same repository
 * at the same path, that is the outcome this call wanted — report convergence rather than
 * erroring, exactly like `host repo rm`'s "already removed by another writer" case. A different
 * path is a real conflict: report it using the record now on the server, not our own intent, so
 * the error names what is actually attached. Neither case retries the loop again. */
function reconcileConflict(currentRecord, hostId, entry) {
  const existing = findAttachedRepository(currentRecord, entry.id);
  if (!existing) return undefined;
  if (existing.path !== entry.path) {
    throw new Error(
      `repository ${entry.id} was attached to host ${hostId} at ${existing.path} by another ` +
        "writer while this command was adding it",
    );
  }
  return {
    attached: true,
    dryRun: false,
    convergedElsewhere: true,
    hostId,
    repository: existing,
    worktreeIds: (existing.worktrees ?? []).map((worktree) => worktree.id),
    toVersion: currentRecord.version,
  };
}
