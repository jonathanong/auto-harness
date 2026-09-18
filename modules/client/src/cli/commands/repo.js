import { CliUsageError } from "../cli-errors.js";
import { runRepoList } from "./repo-list.js";
import { runRepoRm } from "./repo-rm.js";

const USAGE = `usage: auto-harness repo <subcommand> ...
  auto-harness repo list [--limit N] [--cursor C] [--all] [--json]
  auto-harness repo rm <repositoryId> [--json]`;

/** Dispatches `repo <subcommand>` to its own module — mirrors `host.js`'s own dispatch. */
export async function runRepo(argv, io) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") return runRepoList(rest, io);
  if (subcommand === "rm") return runRepoRm(rest, io);
  throw new CliUsageError(USAGE);
}
