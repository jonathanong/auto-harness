import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { formatSessionLine } from "../session-format.js";

const USAGE = "usage: auto-harness session cancel <sessionId> [--json]";

/** `POST /sessions/<id>/cancel`, via the library's `cancelSession()` (which encodes the id
 * itself). A 404 (unknown id) or 409 (already terminal) surfaces through the normal
 * `reportError` path in `main.js`, same as every other command. */
export async function runSessionCancel(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: GLOBAL_VALUE_FLAGS,
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [sessionId] = positionals;
  if (!sessionId || positionals.length > 1) throw new CliUsageError(USAGE);
  // Validates before any request; the encoded value itself is unused since
  // client.cancelSession() encodes the raw id again on its own.
  pathSegment(sessionId, "sessionId");
  const client = await createClient(flags, io);
  const session = await client.cancelSession(sessionId);
  io.stdout.write(
    flags["--json"] ? `${JSON.stringify(session, null, 2)}\n` : formatSessionLine(session),
  );
  return 0;
}
