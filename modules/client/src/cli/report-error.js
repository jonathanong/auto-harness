import { AutoHarnessError, AutoHarnessRequestTimeoutError } from "../errors.js";
import { CliConfigError, CliUsageError } from "./cli-errors.js";

/** Writes a one-line error (plus, for an `AutoHarnessError`, any `details` fields beyond
 * `code`/`message` — e.g. a refused delete's `dependencies`) to `io.stderr` and returns the
 * process exit code for it: 2 for a usage/config error, 1 for anything else. */
export function reportError(error, io) {
  if (error instanceof CliUsageError || error instanceof CliConfigError) {
    io.stderr.write(`error: ${error.message}\n`);
    return 2;
  }
  if (error instanceof AutoHarnessRequestTimeoutError) {
    io.stderr.write(`error: ${error.message}\n`);
    return 1;
  }
  if (error instanceof AutoHarnessError) {
    io.stderr.write(`error: ${error.message} (HTTP ${error.status}, ${error.code})\n`);
    const extra = extraDetailFields(error.details);
    if (extra) io.stderr.write(`${JSON.stringify(extra, null, 2)}\n`);
    return 1;
  }
  io.stderr.write(`error: ${error.message}\n`);
  return 1;
}

function extraDetailFields(details) {
  if (!details || typeof details !== "object") return undefined;
  const extra = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "code" || key === "message") continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}
