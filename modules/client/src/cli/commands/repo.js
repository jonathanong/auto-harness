import { CliUsageError } from "../cli-errors.js";
import { usageUnder } from "../management-commands.js";
import { runRepoAdd } from "./repo-add.js";
import { runRepoList } from "./repo-list.js";
import { runManifestCommand } from "./manifest.js";
import { runRepoRm } from "./repo-rm.js";

const USAGE = `usage: auto-harness repo <subcommand> ...
  auto-harness repo add --name <name> --url <url> [--default-branch <branch>] [--json]
  auto-harness repo list [--limit N] [--cursor C] [--all] [--json]
  auto-harness repo rm <repositoryId> [--json]`;

/** Dispatches `repo <subcommand>` to its own module — mirrors `host.js`'s own dispatch. */
export async function runRepo(argv, io) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "add") return runRepoAdd(rest, io);
  if (subcommand === "list") return runRepoList(rest, io);
  if (subcommand === "rm") return runRepoRm(rest, io);
  const manifestResult = await runManifestCommand(["repo", ...argv], io);
  if (manifestResult !== undefined) return manifestResult;
  const extra = usageUnder(["repo"]);
  throw new CliUsageError(extra.length > 0 ? `${USAGE}\n${extra.join("\n")}` : USAGE);
}
