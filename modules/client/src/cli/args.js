import { CliUsageError } from "./cli-errors.js";

const REJECTED_API_KEY_MESSAGE =
  "--api-key is not accepted on the command line (it would leak into `ps` output and shell " +
  "history); set HARNESS_API_KEY instead, or point --api-key-file / HARNESS_API_KEY_FILE at a file";

/**
 * Splits `argv` into recognized `--flag`/`--flag value`/`--flag=value` entries and positional
 * arguments. Every `--name=value` token is split into name and value *before* any matching, so
 * every check below — the rejected `--api-key` flag, an unknown flag, a value flag missing its
 * value — only ever sees the flag name. This is what keeps a mistyped `--api-key=<secret>` (or
 * any other `--unknown=<secret>`) from echoing the secret back in a "unknown flag" error.
 */
export function parseFlags(argv, { valueFlags = [], booleanFlags = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);
    if (name === "--api-key") throw new CliUsageError(REJECTED_API_KEY_MESSAGE);
    if (valueFlags.includes(name)) {
      const value = inlineValue !== undefined ? inlineValue : argv[(i += 1)];
      if (value === undefined) throw new CliUsageError(`${name} requires a value`);
      flags[name] = value;
      continue;
    }
    if (booleanFlags.includes(name)) {
      if (inlineValue !== undefined) throw new CliUsageError(`${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    throw new CliUsageError(`unknown flag: ${name}`);
  }
  return { flags, positionals };
}
