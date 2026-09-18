import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { conflictDependencies, isDependencyConflict } from "./dependency-conflict.js";

const USAGE = "usage: auto-harness service-account rm <id> [--json]";

/** `DELETE /auth/service-accounts/<id>`. A conflict is handled here, generically — one line per
 * dependency (`kind` + `id`) — rather than by the generic `reportError` pipeline, matching
 * `repo rm`'s pattern without `repo rm`'s per-kind hints. */
export async function runServiceAccountRm(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [id] = positionals;
  if (!id || positionals.length > 1) throw new CliUsageError(USAGE);
  const idSegment = pathSegment(id, "id");
  const client = await createClient(flags, io);
  try {
    await client.request(`/auth/service-accounts/${idSegment}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (!isDependencyConflict(error)) throw error;
    return printConflict(io, flags, error, id);
  }
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ deleted: true, id }, null, 2)}\n`);
  } else {
    io.stdout.write(`service account ${id} deleted\n`);
  }
  return 0;
}

function printConflict(io, flags, error, id) {
  const dependencies = conflictDependencies(error);
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ deleted: false, id, dependencies }, null, 2)}\n`);
    return 1;
  }
  io.stderr.write(`error: ${error.message} (HTTP ${error.status}, ${error.code})\n`);
  for (const dependency of dependencies) {
    io.stderr.write(`  ${dependency.kind} ${dependency.id}\n`);
  }
  return 1;
}
