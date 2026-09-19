import { AutoHarnessError } from "../../index.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { attachRepository } from "./attach-repository.js";
import { parseWorktreeFlags } from "./parse-worktree-flag.js";

const USAGE =
  "usage: auto-harness host repo add <hostId> <repositoryId> --path <path> " +
  "[--worktree <id>=<path>]... [--default-branch <branch>] [--dry-run] [--json]";

/**
 * Attaches an existing repository to a host's inventory — the counterpart of `host repo rm`.
 * A thin wrapper: flag parsing and presentation live here, but the actual read-modify-write
 * lives in `attachRepository` (its own module, reused by a later `host smoke` command).
 */
export async function runHostRepoAdd(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--path", "--default-branch"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--dry-run", "--json"],
    repeatableFlags: ["--worktree"],
  });
  const [hostId, repositoryId] = positionals;
  if (!hostId || !repositoryId || positionals.length > 2 || !flags["--path"]) {
    throw new CliUsageError(USAGE);
  }
  pathSegment(hostId, "hostId"); // validate before createClient, which may log in
  pathSegment(repositoryId, "repositoryId");
  const worktrees = parseWorktreeFlags(flags["--worktree"] ?? []);
  const client = await createClient(flags, io);
  const repository = await getRepositoryOrFail(client, repositoryId);
  const entry = {
    id: repositoryId,
    path: flags["--path"],
    defaultBranch: flags["--default-branch"] ?? repository.defaultBranch,
    worktrees,
  };
  const result = await attachRepository(client, hostId, entry, {
    dryRun: Boolean(flags["--dry-run"]),
  });
  printResult(io, flags, result);
  return 0;
}

/** A 404 here means the id is simply wrong — a clearer message than the generic `error: ...
 * (HTTP 404, NOT_FOUND)` line `reportError` would otherwise print. Any other status (a scoped
 * key that cannot see this repository, a transient failure) is left to the normal error path. */
async function getRepositoryOrFail(client, repositoryId) {
  try {
    return await client.request(`/repositories/${pathSegment(repositoryId, "repositoryId")}`);
  } catch (error) {
    if (error instanceof AutoHarnessError && error.status === 404) {
      throw new Error(`repository ${repositoryId} not found`, { cause: error });
    }
    throw error;
  }
}

function printResult(io, flags, info) {
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  if (info.convergedElsewhere) {
    io.stdout.write(
      `repository ${info.repository.id} was already attached to host ${info.hostId} by ` +
        `another writer at the same path (now at version ${info.toVersion})\n`,
    );
    return;
  }
  const verb = info.dryRun ? "would attach" : "attached";
  const lines = [
    `${verb} repository ${info.repository.id} (${info.repository.path}) to host ${info.hostId}`,
  ];
  if (info.worktreeIds.length > 0) {
    lines.push(`  worktrees: ${info.worktreeIds.join(", ")}`);
  }
  if (!info.dryRun) lines.push(`version ${info.fromVersion} → ${info.toVersion}`);
  io.stdout.write(`${lines.join("\n")}\n`);
}
