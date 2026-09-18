import { CliUsageError } from "../cli-errors.js";
import { runServiceAccountCreate } from "./service-account-create.js";
import { runServiceAccountList } from "./service-account-list.js";
import { runServiceAccountRm } from "./service-account-rm.js";

const USAGE = `usage: auto-harness service-account <subcommand> ...
  auto-harness service-account list [--limit N] [--cursor C] [--all] [--json]
  auto-harness service-account create --name <name> --role <role> [--bound-host <hostId>]
    [--repositories <id,id,...>] (--key-file <path> | --print-key) [--json]
  auto-harness service-account rm <id> [--json]`;

/** Dispatches `service-account <subcommand>` to its own module — mirrors `host.js`'s dispatch. */
export async function runServiceAccount(argv, io) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") return runServiceAccountList(rest, io);
  if (subcommand === "create") return runServiceAccountCreate(rest, io);
  if (subcommand === "rm") return runServiceAccountRm(rest, io);
  throw new CliUsageError(USAGE);
}
