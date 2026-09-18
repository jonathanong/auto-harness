import { CliUsageError } from "../cli-errors.js";
import { runHostRepoRm } from "./host-repo-rm.js";

const USAGE = "usage: auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]";

/** Dispatches `host repo <rm>`. */
export async function runHostRepo(argv, io) {
  const [action, ...rest] = argv;
  if (action === "rm") return runHostRepoRm(rest, io);
  throw new CliUsageError(USAGE);
}
