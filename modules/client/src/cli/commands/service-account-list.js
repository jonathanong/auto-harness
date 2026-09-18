import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { allowlistAccount, formatAccountLine } from "../service-account-format.js";

// Mirrors `host list`'s and `repo list`'s own cap and guard.
const MAX_ALL_PAGES = 20;

/**
 * `GET /auth/service-accounts`, paged with `limit`/`cursor`. Unlike `host list`/`repo list`,
 * `--json` does *not* print the raw page: items are already server-sanitized, but this allowlists
 * them anyway as defense in depth (see `service-account-format.js`) — including in JSON, so a
 * field outside the allowlist can never leak through either output mode.
 */
export async function runServiceAccountList(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--limit", "--cursor"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--all", "--json"],
  });
  if (positionals.length > 0) {
    throw new CliUsageError(
      `service-account list takes no arguments; received: ${positionals.join(" ")}`,
    );
  }
  const client = await createClient(flags, io);
  return flags["--all"] ? runListAll(client, flags, io) : runListOnePage(client, flags, io);
}

function buildQuery(flags, cursor) {
  const query = new URLSearchParams();
  if (flags["--limit"] !== undefined) query.set("limit", flags["--limit"]);
  if (cursor !== undefined) query.set("cursor", cursor);
  const suffix = query.toString();
  return suffix ? `/auth/service-accounts?${suffix}` : "/auth/service-accounts";
}

async function runListOnePage(client, flags, io) {
  const page = await client.request(buildQuery(flags, flags["--cursor"]));
  const items = (page.items ?? []).map(allowlistAccount);
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ items, nextCursor: page.nextCursor }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(formatAccountLines(items));
  if (page.nextCursor) {
    io.stdout.write(
      `more service accounts available; pass --cursor ${page.nextCursor} to continue (or --all)\n`,
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
    items.push(...(page.items ?? []).map(allowlistAccount));
    cursor = page.nextCursor || undefined;
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      throw new Error("repeated pagination cursor for /auth/service-accounts");
    }
    seenCursors.add(cursor);
  }
  if (cursor) {
    io.stderr.write(
      `warning: --all stopped after ${MAX_ALL_PAGES} pages; more service accounts remain ` +
        `(nextCursor: ${cursor})\n`,
    );
  }
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(formatAccountLines(items));
  return 0;
}

function formatAccountLines(items) {
  if (items.length === 0) return "(no service accounts)\n";
  return `${items.map(formatAccountLine).join("\n")}\n`;
}
