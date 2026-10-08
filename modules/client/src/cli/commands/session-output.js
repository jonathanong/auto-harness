import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";

function usage(kind) {
  return `usage: auto-harness session ${kind} <sessionId> [--json]`;
}

/** Reads one session output or artifact status. Artifact URLs are returned only on this explicit request. */
export async function runSessionOutput(argv, io, kind) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  const [sessionId] = positionals;
  if (!sessionId || positionals.length > 1) throw new CliUsageError(usage(kind));
  pathSegment(sessionId, "sessionId");
  const client = await createClient(flags, io);
  const response =
    kind === "output"
      ? await client.getSessionOutput(sessionId)
      : await client.getSessionArtifacts(sessionId);
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  if (response.state === "unsupported")
    io.stdout.write(`${kind} ${kind === "output" ? "is" : "are"} not supported by this host\n`);
  else if (response.state === "pending")
    io.stdout.write(`${kind} ${kind === "output" ? "is" : "are"} still being collected\n`);
  else if (response.state === "none") io.stdout.write(`no ${kind} were captured\n`);
  else if (response.state === "error") {
    io.stdout.write(`${kind} failed: ${response.error.message} (${response.error.code})\n`);
  } else if (kind === "output") {
    io.stdout.write(`${JSON.stringify(response.output, null, 2)}\n`);
    io.stdout.write(`captured at ${response.capturedAt}\n`);
  } else {
    io.stdout.write(`${response.filename} · ${response.compressedBytes} bytes\n`);
    io.stdout.write(`SHA-256 ${response.sha256}\n`);
    io.stdout.write(`Download URL (expires ${response.expiresAt}): ${response.downloadUrl}\n`);
  }
  return 0;
}
