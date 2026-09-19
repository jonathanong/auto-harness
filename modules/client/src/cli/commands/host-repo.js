import { CliUsageError } from "../cli-errors.js";
import { runHostRepoAdd } from "./host-repo-add.js";
import { runHostRepoRm } from "./host-repo-rm.js";

const USAGE = `usage: auto-harness host repo <subcommand> ...
  auto-harness host repo add <hostId> <repositoryId> --path <path> [--worktree <id>=<path>]...
    [--default-branch <branch>] [--dry-run] [--json]
  auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]`;

/** Dispatches `host repo <add|rm>`. */
export async function runHostRepo(argv, io) {
  const [action, ...rest] = argv;
  if (action === "add") return runHostRepoAdd(rest, io);
  if (action === "rm") return runHostRepoRm(rest, io);
  throw new CliUsageError(USAGE);
}
