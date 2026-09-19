import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { detachRepository } from "./detach-repository.js";

const USAGE = "usage: auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]";

/**
 * Detaches one repository from a host's inventory — the counterpart of `host repo add`. A thin
 * wrapper: flag parsing and presentation live here, but the actual safe read-modify-write lives
 * in `detachRepository` (its own module, reused by `host smoke`'s teardown).
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
  const result = await detachRepository(client, hostId, repositoryId, {
    dryRun: Boolean(flags["--dry-run"]),
  });
  printResult(io, flags, result);
  return 0;
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
