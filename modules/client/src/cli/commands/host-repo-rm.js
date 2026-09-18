import { AutoHarnessError } from "../../index.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";

const USAGE = "usage: auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]";
const MAX_ATTEMPTS = 3;

/**
 * Detaches one repository from a host's inventory as a safe read-modify-write: GET the full
 * record, remove only the target repository (its worktrees go with it — that is a projection
 * of the repository, not a separate thing to delete), and PUT back everything else — including
 * `providerAccounts` — exactly as read, with the read `version` kept. On a 409 (someone else
 * wrote first) it re-reads and re-applies, up to `MAX_ATTEMPTS` PUTs total; any other status is
 * not retried.
 */
export async function runHostRepoRm(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--dry-run", "--json"],
  });
  const [hostId, repositoryId] = positionals;
  if (!hostId || !repositoryId || positionals.length > 2) throw new CliUsageError(USAGE);
  pathSegment(hostId, "hostId"); // validate before createClient, which may log in
  const client = await createClient(flags, io);
  const record = await getInventory(client, hostId);
  const removal = extractRepository(record, hostId, repositoryId);
  if (flags["--dry-run"]) {
    printResult(io, flags, { dryRun: true, hostId, ...removal });
    return 0;
  }
  return removeWithRetry(client, io, flags, hostId, repositoryId, record, removal);
}

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

async function removeWithRetry(client, io, flags, hostId, repositoryId, record, removal) {
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
      printResult(io, flags, {
        dryRun: false,
        hostId,
        repository: current.repository,
        worktreeIds: current.worktreeIds,
        fromVersion,
        toVersion: result?.version,
      });
      return 0;
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
        printResult(io, flags, {
          convergedElsewhere: true,
          hostId,
          repository: current.repository,
          worktreeIds: current.worktreeIds,
          toVersion: currentRecord.version,
        });
        return 0;
      }
      current = next;
    }
  }
  /* v8 ignore next 2 -- the loop above always returns or throws before falling out */
  return 1;
}

function printResult(io, flags, info) {
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  if (info.convergedElsewhere) {
    io.stdout.write(
      `repository ${info.repository.id} was already removed from host ${info.hostId} by ` +
        `another writer (now at version ${info.toVersion})\n`,
    );
    return;
  }
  const verb = info.dryRun ? "would remove" : "removed";
  const lines = [
    `${verb} repository ${info.repository.id} (${info.repository.path}) from host ${info.hostId}`,
  ];
  if (info.worktreeIds.length > 0) {
    lines.push(`  worktrees removed with it: ${info.worktreeIds.join(", ")}`);
  }
  if (!info.dryRun) lines.push(`version ${info.fromVersion} → ${info.toVersion}`);
  io.stdout.write(`${lines.join("\n")}\n`);
}
