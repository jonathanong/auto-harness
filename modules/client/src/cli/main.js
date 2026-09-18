import { runApi } from "./commands/api.js";
import { runDoctor } from "./commands/doctor.js";
import { runWhoami } from "./commands/whoami.js";
import { reportError } from "./report-error.js";
import { usage } from "./usage.js";

const HELP_TOKENS = new Set(["help", "--help", "-h"]);

/**
 * Runs the CLI end to end and resolves to a process exit code — 0 on success, 1 for an
 * API/HTTP failure or a failed `doctor` check, 2 for a usage or configuration error. Every
 * dependency on the outside world (env, fetch, the standard streams, file reads) is injected
 * through `io` so this never spawns a process or touches the real network in tests.
 */
export async function main(argv, io) {
  const [command, ...rest] = argv;
  if (command === undefined || HELP_TOKENS.has(command)) {
    io.stdout.write(usage());
    return 0;
  }
  try {
    if (command === "api") return await runApi(rest, io);
    if (command === "whoami") return await runWhoami(rest, io);
    if (command === "doctor") return await runDoctor(rest, io);
    io.stderr.write(usage());
    return 2;
  } catch (error) {
    return reportError(error, io);
  }
}
