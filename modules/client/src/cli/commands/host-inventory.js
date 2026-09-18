import { CliUsageError } from "../cli-errors.js";
import { runHostInventoryGet } from "./host-inventory-get.js";
import { runHostInventorySet } from "./host-inventory-set.js";

const USAGE = `usage: auto-harness host inventory <get|set> ...
  auto-harness host inventory get <hostId> [--json]
  auto-harness host inventory set <hostId> --file <path|->`;

/** Dispatches `host inventory <get|set>`. */
export async function runHostInventory(argv, io) {
  const [action, ...rest] = argv;
  if (action === "get") return runHostInventoryGet(rest, io);
  if (action === "set") return runHostInventorySet(rest, io);
  throw new CliUsageError(USAGE);
}
