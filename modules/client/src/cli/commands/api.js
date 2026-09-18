import { checkAdminLoginUsage } from "../admin-login.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { readStdin } from "../read-stdin.js";

const USAGE = "usage: auto-harness api <METHOD> <path> [--body <json> | --body-file <path|->]";

// Methods the control-plane API uses. An explicit list rather than HTTP's token grammar: Fetch
// also rejects valid tokens (CONNECT, TRACE, TRACK), and a typo should be a usage error (exit 2)
// before anything is sent, not a Fetch TypeError surfacing as an API failure (exit 1).
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// Segments the WHATWG URL parser resolves as "." and "..", percent-encoded forms included
// (compared case-insensitively). Letting one through would resolve the request outside
// `/api/v1` — e.g. `/../../health` becomes `/health` — with the bearer token still attached.
const DOT_SEGMENTS = new Set([".", "..", "%2e", "%2e%2e", ".%2e", "%2e."]);

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
  const httpMethod = method.toUpperCase();
  if (!METHODS.has(httpMethod)) {
    throw new CliUsageError(
      `unsupported HTTP method ${method}; use one of ${[...METHODS].join(", ")}`,
    );
  }
  const apiPath = normalizeApiPath(path);
  // Both this command's own `--body-file -` and `--admin-password-stdin` need stdin; catch the
  // conflict before reading either, rather than letting one silently drain the other's input.
  const stdinClaimedBy = flags["--body-file"] === "-" ? "api --body-file -" : undefined;
  checkAdminLoginUsage(flags, io.env, stdinClaimedBy);
  const body = await resolveBody(flags, io);
  const client = await createClient(flags, io);
  const result = await client.request(apiPath, {
    method: httpMethod,
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
 * `/api/v1/hosts` by stripping a leading `/api/v1` segment before handing the path along.
 * Rejects any dot segment in the path part (the query string is not a path), splitting on `\`
 * as well as `/` because an https URL treats a backslash as a segment separator. */
function normalizeApiPath(path) {
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const stripped = withLeadingSlash.replace(/^\/api\/v1(?=\/|$)/, "");
  const pathPart = stripped.split(/[?#]/, 1)[0];
  if (pathPart.split(/[/\\]/).some((segment) => DOT_SEGMENTS.has(segment.toLowerCase()))) {
    throw new CliUsageError(`path must not contain "." or ".." segments: ${path}`);
  }
  return stripped === "" ? "/" : stripped;
}
