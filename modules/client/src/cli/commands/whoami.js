import { allowlistPrincipal, formatWhoami } from "../allowlist.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";

/** `GET /auth/me`, printing only the allowlisted principal fields (see allowlist.js for why the
 * response shape is not trusted). */
export async function runWhoami(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  if (positionals.length > 0) {
    throw new CliUsageError(`whoami takes no arguments; received: ${positionals.join(" ")}`);
  }
  const client = await createClient(flags, io);
  const principal = allowlistPrincipal(await client.request("/auth/me"));
  io.stdout.write(
    flags["--json"] ? `${JSON.stringify(principal, null, 2)}\n` : formatWhoami(principal),
  );
  return 0;
}
