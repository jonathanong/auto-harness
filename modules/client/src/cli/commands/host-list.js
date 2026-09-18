import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";

// This repo's list/history invariant forbids unbounded collection of pages at storage, so
// `--all` stops here and warns rather than following `nextCursor` forever.
const MAX_ALL_PAGES = 20;

/** `GET /hosts`, optionally filtered by `online`/`offline` and paged with `limit`/`cursor`.
 * `--all` follows `nextCursor` itself, capped at `MAX_ALL_PAGES` pages. */
export async function runHostList(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--limit", "--cursor"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--online", "--offline", "--all", "--json"],
  });
  if (positionals.length > 0) {
    throw new CliUsageError(`host list takes no arguments; received: ${positionals.join(" ")}`);
  }
  if (flags["--online"] && flags["--offline"]) {
    throw new CliUsageError("--online and --offline are mutually exclusive");
  }
  const client = await createClient(flags, io);
  return flags["--all"] ? runListAll(client, flags, io) : runListOnePage(client, flags, io);
}

function buildQuery(flags, cursor) {
  const query = new URLSearchParams();
  if (flags["--online"]) query.set("online", "online");
  if (flags["--offline"]) query.set("online", "offline");
  if (flags["--limit"] !== undefined) query.set("limit", flags["--limit"]);
  if (cursor !== undefined) query.set("cursor", cursor);
  const suffix = query.toString();
  return suffix ? `/hosts?${suffix}` : "/hosts";
}

async function runListOnePage(client, flags, io) {
  const page = await client.request(buildQuery(flags, flags["--cursor"]));
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(formatHostLines(page.items ?? []));
  if (page.nextCursor) {
    io.stdout.write(
      `more hosts available; pass --cursor ${page.nextCursor} to continue (or --all)\n`,
    );
  }
  return 0;
}

async function runListAll(client, flags, io) {
  const items = [];
  const seenCursors = new Set();
  let cursor = flags["--cursor"];
  for (let pageCount = 0; pageCount < MAX_ALL_PAGES; pageCount += 1) {
    const page = await client.request(buildQuery(flags, cursor));
    items.push(...(page.items ?? []));
    cursor = page.nextCursor || undefined;
    if (!cursor) break;
    // Mirrors the same guard in AutoHarnessClient#listCatalog: a server repeating a cursor is a
    // bug worth failing loudly on, not something to paper over as "more pages than the cap".
    if (seenCursors.has(cursor)) throw new Error("repeated pagination cursor for /hosts");
    seenCursors.add(cursor);
  }
  if (cursor) {
    io.stderr.write(
      `warning: --all stopped after ${MAX_ALL_PAGES} pages; more hosts remain ` +
        `(nextCursor: ${cursor})\n`,
    );
  }
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(formatHostLines(items));
  return 0;
}

function formatHostLines(items) {
  if (items.length === 0) return "(no hosts)\n";
  return `${items
    .map(
      (host) =>
        `${host.hostId}  ${host.online ? "online" : "offline"}${host.draining ? "  draining" : ""}`,
    )
    .join("\n")}\n`;
}
