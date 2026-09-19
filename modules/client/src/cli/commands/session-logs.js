import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";

const USAGE = "usage: auto-harness session logs <sessionId> [--limit N] [--cursor C] [--json]";

// Mirrors DEFAULT_LOG_QUERY_LIMIT in services/api/src/log-query.ts — used only to guess whether
// a page came back full when --limit was not given (see the pagination note below).
const DEFAULT_LOG_LIMIT = 1000;

/**
 * `GET /sessions/<id>/logs`. Unlike `repo list`/`host list`, this endpoint returns `{ items }`
 * with no `nextCursor` — its only continuation knob is `since` (services/api/src/log-query.ts),
 * a whole ISO-8601 timestamp, exclusive. This CLI exposes that as `--cursor` for a pagination
 * vocabulary consistent with the other list commands, mapped straight to `since`. Passing the
 * last printed item's own `timestamp` back as the next `--cursor` therefore excludes *every*
 * record sharing that exact timestamp, not only the one already shown — coarser than a true row
 * cursor, but that is the bounded contract `parseLogQuery` actually offers (the true `after`
 * cursor is internal-only, used by viewer reconnects, and never exposed over REST). One page is
 * printed; never looped, per this repo's list/history invariant.
 */
export async function runSessionLogs(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--limit", "--cursor"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [sessionId] = positionals;
  if (!sessionId || positionals.length > 1) throw new CliUsageError(USAGE);
  for (const name of ["--limit", "--cursor"]) {
    if (flags[name] !== undefined && flags[name].trim() === "") {
      throw new CliUsageError(`${name} was given an empty value`);
    }
  }
  const limit = flags["--limit"] !== undefined ? Number(flags["--limit"]) : DEFAULT_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CliUsageError("--limit must be a positive integer");
  }
  const sessionSegment = pathSegment(sessionId, "sessionId");
  const client = await createClient(flags, io);
  const query = new URLSearchParams();
  if (flags["--limit"] !== undefined) query.set("limit", flags["--limit"]);
  if (flags["--cursor"] !== undefined) query.set("since", flags["--cursor"]);
  const suffix = query.toString();
  const page = await client.request(
    `/sessions/${sessionSegment}/logs${suffix ? `?${suffix}` : ""}`,
  );
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
    return 0;
  }
  const items = page.items ?? [];
  io.stdout.write(formatLogLines(items));
  if (items.length === limit) {
    io.stdout.write(
      `more logs may be available; pass --cursor ${items.at(-1).timestamp} to continue\n`,
    );
  }
  return 0;
}

function formatLogLines(items) {
  if (items.length === 0) return "(no logs)\n";
  return `${items.map((item) => `${item.timestamp}  [${item.stream}]  ${item.content}`).join("\n")}\n`;
}
