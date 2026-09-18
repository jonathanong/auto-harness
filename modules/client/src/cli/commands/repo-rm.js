import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { conflictDependencies, isDependencyConflict } from "./dependency-conflict.js";

const USAGE = "usage: auto-harness repo rm <repositoryId> [--json]";

/**
 * `DELETE /repositories/<id>`. A 409 is handled here rather than by the generic `reportError`
 * pipeline: the whole point of this command is that the refusal explains itself, one concrete
 * next step per blocking dependency, rather than a `dependencies` array dumped as raw JSON.
 */
export async function runRepoRm(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [repositoryId] = positionals;
  if (!repositoryId || positionals.length > 1) throw new CliUsageError(USAGE);
  const repositorySegment = pathSegment(repositoryId, "repositoryId");
  const client = await createClient(flags, io);
  try {
    await client.request(`/repositories/${repositorySegment}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (!isDependencyConflict(error)) throw error;
    return printConflict(io, flags, error, repositoryId);
  }
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ deleted: true, id: repositoryId }, null, 2)}\n`);
  } else {
    io.stdout.write(`repository ${repositoryId} deleted\n`);
  }
  return 0;
}

function printConflict(io, flags, error, repositoryId) {
  const dependencies = conflictDependencies(error);
  const hints = dependencies.map((dependency) => hintFor(dependency, dependencies, repositoryId));
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ deleted: false, dependencies, hints }, null, 2)}\n`);
    return 1;
  }
  io.stderr.write(`error: ${error.message} (HTTP ${error.status}, ${error.code})\n`);
  for (const hint of hints) io.stderr.write(`  ${hint}\n`);
  return 1;
}

/** One concrete next step per dependency `kind`. `worktree` is special-cased: worktrees are
 * removed by detaching the repository from its host, so the hint names that host — taken from a
 * sibling `host-inventory` dependency in the same response when present, else the literal
 * placeholder `<hostId>`. */
function hintFor(dependency, dependencies, repositoryId) {
  const { kind, id, status } = dependency;
  if (kind === "schedule") return `${kind} ${id}: auto-harness api DELETE /schedules/${id}`;
  if (kind === "session") {
    return (
      `${kind} ${id} is still running (status: ${status}); wait for it, or ` +
      `auto-harness api POST /sessions/${id}/cancel`
    );
  }
  if (kind === "session-drain") {
    return (
      `${kind} ${id} (status: ${status}): auto-harness api POST ` +
      `/repositories/${repositoryId}/session-drains/${id}/release`
    );
  }
  if (kind === "host-inventory") {
    return `${kind} ${id}: auto-harness host repo rm ${id} ${repositoryId}`;
  }
  if (kind === "worktree") {
    const host = dependencies.find((candidate) => candidate.kind === "host-inventory");
    const hostId = host ? host.id : "<hostId>";
    return `${kind} ${id}: auto-harness host repo rm ${hostId} ${repositoryId}`;
  }
  if (kind === "integration" && id === "github-ingress") {
    return `${kind} ${id}: remove this repository's binding from the GitHub ingress configuration`;
  }
  if (kind === "integration") return `${kind} ${id}: remove or retarget integration ${id}`;
  return `${kind} ${id}`;
}
