import { AutoHarnessError } from "../../index.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { reportError } from "../report-error.js";

/**
 * Shared shape for `host drain` and `host resume`: both POST `{ hostId }` in the body — never
 * the path, see `local-routes-host-drain.ts` — and both can 409 on a host connection race. A
 * 409 is reported here, inside the command, rather than left to `main.js`'s catch: once that
 * catch runs there is no way back into this function to add the trailing retry hint, so this
 * prints the normal error line itself (via `reportError`) and then the hint, in that order.
 * `onSuccess(result, hostId, flags)` writes the success output — it closes over its own `io`
 * rather than taking one here, so it does not shadow this function's `io` parameter.
 */
export async function runHostIdPostAction(argv, io, { commandName, path, onSuccess }) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [hostId] = positionals;
  if (!hostId || positionals.length > 1) {
    throw new CliUsageError(`usage: auto-harness host ${commandName} <hostId> [--json]`);
  }
  const client = await createClient(flags, io);
  let result;
  try {
    result = await client.request(path, { method: "POST", body: JSON.stringify({ hostId }) });
  } catch (error) {
    const exitCode = reportError(error, io);
    if (error instanceof AutoHarnessError && error.status === 409) {
      io.stderr.write("hint: the host's connection changed mid-request; retrying is safe\n");
    }
    return exitCode;
  }
  onSuccess(result, hostId, flags);
  return 0;
}
