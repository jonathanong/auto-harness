import { runApi } from "./commands/api.js";
import { runDoctor } from "./commands/doctor.js";
import { runHost } from "./commands/host.js";
import { runRepo } from "./commands/repo.js";
import { runServiceAccount } from "./commands/service-account.js";
import { runWhoami } from "./commands/whoami.js";
import { GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "./config.js";
import { reportError } from "./report-error.js";
import { usage } from "./usage.js";

const HELP_TOKENS = new Set(["help", "--help", "-h"]);

/**
 * A global flag (`--admin-password-stdin`, `--api-url`, ...) is recognized wherever it appears,
 * not only after the command name — `auto-harness --admin-password-stdin service-account create`
 * reads the same as `auto-harness service-account create --admin-password-stdin`. This walks
 * only the *leading* run of `--flag` tokens (an unknown leading flag, e.g. a mistyped one or the
 * rejected `--api-key`, is left in place and falls through to the usage/exit-2 path below,
 * exactly as an unrecognized command would), moves each one after the command name, and hands
 * the rest of `argv` to the matched subcommand's own `parseFlags` untouched.
 */
function hoistLeadingGlobalFlags(argv) {
  const hoisted = [];
  let index = 0;
  while (index < argv.length && argv[index].startsWith("--")) {
    const arg = argv[index];
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (GLOBAL_BOOLEAN_FLAGS.includes(name) && equals === -1) {
      hoisted.push(arg);
      index += 1;
    } else if (GLOBAL_VALUE_FLAGS.includes(name) && equals !== -1) {
      hoisted.push(arg);
      index += 1;
    } else if (GLOBAL_VALUE_FLAGS.includes(name) && index + 1 < argv.length) {
      hoisted.push(arg, argv[index + 1]);
      index += 2;
    } else {
      break;
    }
  }
  return { command: argv[index], rest: [...argv.slice(index + 1), ...hoisted] };
}

/**
 * Runs the CLI end to end and resolves to a process exit code — 0 on success, 1 for an
 * API/HTTP failure or a failed `doctor` check, 2 for a usage or configuration error. Every
 * dependency on the outside world (env, fetch, the standard streams, file reads) is injected
 * through `io` so this never spawns a process or touches the real network in tests.
 */
export async function main(argv, io) {
  const { command, rest } = hoistLeadingGlobalFlags(argv);
  if (command === undefined || HELP_TOKENS.has(command)) {
    io.stdout.write(usage());
    return 0;
  }
  try {
    if (command === "api") return await runApi(rest, io);
    if (command === "whoami") return await runWhoami(rest, io);
    if (command === "doctor") return await runDoctor(rest, io);
    if (command === "host") return await runHost(rest, io);
    if (command === "repo") return await runRepo(rest, io);
    if (command === "service-account") return await runServiceAccount(rest, io);
    io.stderr.write(usage());
    return 2;
  } catch (error) {
    return reportError(error, io);
  }
}
