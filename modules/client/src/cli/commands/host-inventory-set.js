import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { readStdin } from "../read-stdin.js";

const USAGE = "usage: auto-harness host inventory set <hostId> --file <path|->";

const MISSING_VERSION_MESSAGE =
  "the document has no integer `version` field: omitting it silently disables optimistic " +
  "concurrency on the server, so a concurrent change could be overwritten with no error; " +
  "start from `auto-harness host inventory get <hostId> --json` and edit that";

/**
 * `PUT /hosts/<hostId>/inventory`. The PUT is authoritative — it replaces the whole record —
 * so this sends the file/stdin text verbatim as the request body rather than re-serializing a
 * parsed copy; it only parses to validate that the document is a JSON object carrying the
 * integer `version` the server needs for optimistic concurrency.
 */
export async function runHostInventorySet(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--file"],
    booleanFlags: GLOBAL_BOOLEAN_FLAGS,
  });
  const [hostId] = positionals;
  if (!hostId || positionals.length > 1 || !flags["--file"]) throw new CliUsageError(USAGE);
  const hostSegment = pathSegment(hostId, "hostId");
  const text = await readDocument(flags["--file"], io);
  validateDocument(text);
  const client = await createClient(flags, io);
  const result = await client.request(`/hosts/${hostSegment}/inventory`, {
    method: "PUT",
    body: text,
  });
  io.stdout.write(`inventory for host ${hostId} set to version ${result?.version}\n`);
  return 0;
}

async function readDocument(path, io) {
  if (path === "-") return readStdin(io.stdin);
  try {
    return await io.readFile(path, "utf8");
  } catch (error) {
    throw new CliUsageError(`could not read --file ${path}: ${error.message}`);
  }
}

function validateDocument(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new CliUsageError("--file must contain valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new CliUsageError("--file must contain a JSON object");
  }
  if (!Number.isInteger(document.version)) {
    throw new CliUsageError(MISSING_VERSION_MESSAGE);
  }
}
