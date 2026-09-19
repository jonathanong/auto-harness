import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { formatSessionLine } from "../session-format.js";

const USAGE = "usage: auto-harness session get <sessionId> [--json]";

/** `GET /sessions/<id>`, via the library's `getSession()` (which encodes the id itself). */
export async function runSessionGet(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [sessionId] = positionals;
  if (!sessionId || positionals.length > 1) throw new CliUsageError(USAGE);
  // Validates before any request (and before an admin-mode login); the encoded value itself is
  // unused since client.getSession() encodes the raw id again on its own.
  pathSegment(sessionId, "sessionId");
  const client = await createClient(flags, io);
  const session = await client.getSession(sessionId);
  io.stdout.write(
    flags["--json"] ? `${JSON.stringify(session, null, 2)}\n` : formatSessionLine(session),
  );
  return 0;
}
