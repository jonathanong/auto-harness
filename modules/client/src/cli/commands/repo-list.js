import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";

// This repo's list/history invariant forbids unbounded collection of pages at storage, so
// `--all` stops here and warns rather than following `nextCursor` forever. Mirrors `host list`.
const MAX_ALL_PAGES = 20;

/** `GET /repositories`, paged with `limit`/`cursor`. `--all` follows `nextCursor` itself,
 * capped at `MAX_ALL_PAGES` pages. */
export async function runRepoList(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--limit", "--cursor"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--all", "--json"],
  });
  if (positionals.length > 0) {
    throw new CliUsageError(`repo list takes no arguments; received: ${positionals.join(" ")}`);
  }
  const client = await createClient(flags, io);
  return flags["--all"] ? runListAll(client, flags, io) : runListOnePage(client, flags, io);
}

function buildQuery(flags, cursor) {
  const query = new URLSearchParams();
  if (flags["--limit"] !== undefined) query.set("limit", flags["--limit"]);
  if (cursor !== undefined) query.set("cursor", cursor);
  const suffix = query.toString();
  return suffix ? `/repositories?${suffix}` : "/repositories";
}

async function runListOnePage(client, flags, io) {
  const page = await client.request(buildQuery(flags, flags["--cursor"]));
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(formatRepoLines(page.items ?? []));
  if (page.nextCursor) {
    io.stdout.write(
      `more repositories available; pass --cursor ${page.nextCursor} to continue (or --all)\n`,
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
    if (seenCursors.has(cursor)) throw new Error("repeated pagination cursor for /repositories");
    seenCursors.add(cursor);
  }
  if (cursor) {
    io.stderr.write(
      `warning: --all stopped after ${MAX_ALL_PAGES} pages; more repositories remain ` +
        `(nextCursor: ${cursor})\n`,
    );
  }
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(formatRepoLines(items));
  return 0;
}

function formatRepoLines(items) {
  if (items.length === 0) return "(no repositories)\n";
  return `${items.map(formatRepoLine).join("\n")}\n`;
}

function formatRepoLine(repo) {
  const parts = [repo.id, repo.name];
  if (repo.status) parts.push(repo.status);
  if (repo.url) parts.push(repo.url);
  return parts.join("  ");
}
