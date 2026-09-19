import { CliUsageError } from "../cli-errors.js";
import { runSessionCancel } from "./session-cancel.js";
import { runSessionCreate } from "./session-create.js";
import { runSessionGet } from "./session-get.js";
import { runSessionLogs } from "./session-logs.js";

const USAGE = `usage: auto-harness session <subcommand> ...
  auto-harness session create --repo <repositoryId> (--provider <id|name> | --command <id|name>) --prompt <text>
    [--timeout <seconds>] [--ref <ref>] [--concurrency-id <id>] [--wait [--wait-timeout <seconds>]] [--json]
  auto-harness session get <sessionId> [--json]
  auto-harness session logs <sessionId> [--limit N] [--cursor C] [--json]
  auto-harness session cancel <sessionId> [--json]`;

/** Dispatches `session <subcommand>` to its own module — mirrors `host.js`'s own dispatch. */
export async function runSession(argv, io) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "create") return runSessionCreate(rest, io);
  if (subcommand === "get") return runSessionGet(rest, io);
  if (subcommand === "logs") return runSessionLogs(rest, io);
  if (subcommand === "cancel") return runSessionCancel(rest, io);
  throw new CliUsageError(USAGE);
}
