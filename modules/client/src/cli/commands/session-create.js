import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { formatSessionLine } from "../session-format.js";
import { waitForSession } from "../wait-for-session.js";
import { resolveSessionTarget } from "./session-target.js";

const USAGE =
  "usage: auto-harness session create --repo <repositoryId> " +
  "(--provider <id|name> | --command <id|name>) --prompt <text> [--timeout <seconds>] " +
  "[--ref <ref>] [--concurrency-id <id>] [--wait [--wait-timeout <seconds>]] [--json]";

const VALUE_FLAGS = [
  "--repo",
  "--provider",
  "--command",
  "--prompt",
  "--timeout",
  "--ref",
  "--concurrency-id",
  "--wait-timeout",
];

// Mirrors the create-session form's own default in
// services/web/src/components/session-timeout-field.tsx (`SessionTimeoutField`,
// `initialSeconds = 600`). The server requires `timeout`; there is no server-side default
// (`sessionTimeoutError` in modules/shared/src/validation.ts rejects `undefined`).
const DEFAULT_TIMEOUT_SECONDS = 600;

// Arbitrary, small: keeps `--wait` responsive without hammering the API.
const WAIT_POLL_INTERVAL_MS = 2_000;

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(`${label} must be a positive number`);
  }
  return parsed;
}

function validateFlags(flags) {
  for (const name of VALUE_FLAGS) {
    if (flags[name] !== undefined && flags[name].trim() === "") {
      throw new CliUsageError(`${name} was given an empty value`);
    }
  }
  if (!flags["--repo"] || flags["--prompt"] === undefined) throw new CliUsageError(USAGE);
  const hasProvider = flags["--provider"] !== undefined;
  const hasCommand = flags["--command"] !== undefined;
  if (hasProvider === hasCommand) {
    throw new CliUsageError("exactly one of --provider or --command is required");
  }
  if (flags["--wait-timeout"] !== undefined && !flags["--wait"]) {
    throw new CliUsageError("--wait-timeout requires --wait");
  }
}

/**
 * `POST /sessions`. `--provider`/`--command` accept either an id or a name (see
 * `session-target.js`); `--timeout` defaults to `DEFAULT_TIMEOUT_SECONDS` since the server
 * requires it but has no default of its own. With `--wait`, polls via `waitForSession()` —
 * status changes go to stderr, the final session record to stdout — and exits 0 only when the
 * session `completed` with `exitCode === 0`; any other terminal status, or the wait timing out,
 * exits 1 (a timed-out wait never cancels the session).
 */
export async function runSessionCreate(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, ...VALUE_FLAGS],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--wait", "--json"],
  });
  if (positionals.length > 0) throw new CliUsageError(USAGE);
  validateFlags(flags);
  const timeout =
    flags["--timeout"] !== undefined
      ? parsePositiveNumber(flags["--timeout"], "--timeout")
      : DEFAULT_TIMEOUT_SECONDS;
  const waitTimeoutSeconds = flags["--wait"]
    ? flags["--wait-timeout"] !== undefined
      ? parsePositiveNumber(flags["--wait-timeout"], "--wait-timeout")
      : timeout
    : undefined;

  const client = await createClient(flags, io);
  const target = await resolveSessionTarget(client, flags);
  const created = await client.createSession({
    repositoryId: flags["--repo"],
    prompt: flags["--prompt"],
    target,
    timeout,
    ...(flags["--ref"] !== undefined ? { ref: flags["--ref"] } : {}),
    ...(flags["--concurrency-id"] !== undefined
      ? { concurrencyId: flags["--concurrency-id"] }
      : {}),
  });
  if (!flags["--wait"]) return writeResult(io, flags, created, 0);

  const { timedOut, session } = await waitForSession(client, created.id, {
    timeoutMs: waitTimeoutSeconds * 1000,
    intervalMs: WAIT_POLL_INTERVAL_MS,
    onStatus: (status) => io.stderr.write(`session ${created.id}: ${status}\n`),
  });
  if (timedOut) {
    io.stderr.write(
      `session ${created.id} is still running after ${waitTimeoutSeconds}s; not cancelling it\n`,
    );
    return writeResult(io, flags, session, 1);
  }
  const succeeded = session.status === "completed" && session.exitCode === 0;
  return writeResult(io, flags, session, succeeded ? 0 : 1);
}

function writeResult(io, flags, session, exitCode) {
  io.stdout.write(
    flags["--json"] ? `${JSON.stringify(session, null, 2)}\n` : formatSessionLine(session),
  );
  return exitCode;
}
