import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";

const USAGE = "usage: auto-harness host inventory get <hostId> [--json]";

/** `GET /hosts/<hostId>/inventory`. */
export async function runHostInventoryGet(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [hostId] = positionals;
  if (!hostId || positionals.length > 1) throw new CliUsageError(USAGE);
  const client = await createClient(flags, io);
  const record = await client.request(`/hosts/${encodeURIComponent(hostId)}/inventory`);
  io.stdout.write(
    flags["--json"] ? `${JSON.stringify(record, null, 2)}\n` : formatInventory(record),
  );
  return 0;
}

function formatInventory(record) {
  const lines = [`version: ${record.version ?? 0}`];
  const repositories = record.repositories ?? [];
  if (repositories.length === 0) {
    lines.push("repositories: (none)");
  } else {
    lines.push("repositories:");
    for (const repository of repositories) {
      const worktreeCount = (repository.worktrees ?? []).length;
      const label = worktreeCount === 1 ? "worktree" : "worktrees";
      lines.push(`  ${repository.id}  ${repository.path}  (${worktreeCount} ${label})`);
    }
  }
  lines.push(`provider accounts: ${(record.providerAccounts ?? []).length}`);
  return `${lines.join("\n")}\n`;
}
