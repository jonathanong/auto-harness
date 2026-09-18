import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { readStdin } from "../read-stdin.js";

const USAGE = "usage: auto-harness api <METHOD> <path> [--body <json> | --body-file <path|->]";

/**
 * Generic escape hatch for any route. Prints the response's parsed JSON, pretty-printed, on
 * success; prints nothing for a 204 or otherwise empty body. Deliberately does not filter the
 * response the way `whoami`/`doctor` do — an operator asking for `GET /auth/me` through this
 * command gets the raw body, hashes included, because filtering an explicit raw-response request
 * would defeat the point of having an escape hatch at all.
 */
export async function runApi(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--body", "--body-file"],
    booleanFlags: GLOBAL_BOOLEAN_FLAGS,
  });
  const [method, path] = positionals;
  if (!method || !path || positionals.length > 2) throw new CliUsageError(USAGE);
  if (flags["--body"] !== undefined && flags["--body-file"] !== undefined) {
    throw new CliUsageError("--body and --body-file are mutually exclusive");
  }
  const body = await resolveBody(flags, io);
  const client = await createClient(flags, io);
  const result = await client.request(normalizeApiPath(path), {
    method: method.toUpperCase(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (result !== undefined) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function resolveBody(flags, io) {
  let text;
  if (flags["--body"] !== undefined) text = flags["--body"];
  else if (flags["--body-file"] === "-") text = await readStdin(io.stdin);
  else if (flags["--body-file"] !== undefined) {
    text = await readBodyFile(flags["--body-file"], io.readFile);
  } else return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliUsageError("--body/--body-file must contain valid JSON");
  }
}

async function readBodyFile(path, readFile) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new CliUsageError(`could not read --body-file ${path}: ${error.message}`);
  }
}

/** The client already prefixes every path with `/api/v1`, so accept both `/hosts` and
 * `/api/v1/hosts` by stripping a leading `/api/v1` segment before handing the path along. */
function normalizeApiPath(path) {
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const stripped = withLeadingSlash.replace(/^\/api\/v1(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}
