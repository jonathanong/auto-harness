import { CliUsageError } from "../cli-errors.js";
import { usageUnder } from "../management-commands.js";
import { runHostInventoryGet } from "./host-inventory-get.js";
import { runHostInventorySet } from "./host-inventory-set.js";
import { runManifestCommand } from "./manifest.js";

const USAGE = `usage: auto-harness host inventory <get|set> ...
  auto-harness host inventory get <hostId> [--json]
  auto-harness host inventory set <hostId> --file <path|->`;

/** Dispatches `host inventory <get|set>`. */
export async function runHostInventory(argv, io) {
  const [action, ...rest] = argv;
  if (action === "get") return runHostInventoryGet(rest, io);
  if (action === "set") return runHostInventorySet(rest, io);
  const manifestResult = await runManifestCommand(["host", "inventory", ...argv], io);
  if (manifestResult !== undefined) return manifestResult;
  const extra = usageUnder(["host", "inventory"]);
  throw new CliUsageError(extra.length > 0 ? `${USAGE}\n${extra.join("\n")}` : USAGE);
}
