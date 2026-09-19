import { CliUsageError } from "../cli-errors.js";
import { runHostDrain } from "./host-drain.js";
import { runHostInventory } from "./host-inventory.js";
import { runHostList } from "./host-list.js";
import { runHostRepo } from "./host-repo.js";
import { runHostResume } from "./host-resume.js";
import { runHostSmoke } from "./host-smoke.js";

const USAGE = `usage: auto-harness host <subcommand> ...
  auto-harness host list [--online | --offline] [--limit N] [--cursor C] [--all] [--json]
  auto-harness host drain <hostId> [--json]
  auto-harness host resume <hostId> [--json]
  auto-harness host inventory get <hostId> [--json]
  auto-harness host inventory set <hostId> --file <path|->
  auto-harness host repo add <hostId> <repositoryId> --path <path> [--worktree <id>=<path>]...
    [--default-branch <branch>] [--dry-run] [--json]
  auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]
  auto-harness host smoke <hostId> --repo-path <path> --provider <id|name>
    [--provider <id|name>]... [--timeout <seconds>] [--json]`;

/** Dispatches `host <subcommand>` to its own module — mirrors `main.js`'s own dispatch. */
export async function runHost(argv, io) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") return runHostList(rest, io);
  if (subcommand === "drain") return runHostDrain(rest, io);
  if (subcommand === "resume") return runHostResume(rest, io);
  if (subcommand === "inventory") return runHostInventory(rest, io);
  if (subcommand === "repo") return runHostRepo(rest, io);
  if (subcommand === "smoke") return runHostSmoke(rest, io);
  throw new CliUsageError(USAGE);
}
