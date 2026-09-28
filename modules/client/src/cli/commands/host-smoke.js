import { randomBytes } from "node:crypto";

import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { printSummary, step } from "./host-smoke-format.js";
import { runProviderSmoke } from "./host-smoke-provider.js";
import { loadSmokeRepository, verifySmokeAttachment } from "./host-smoke-repository.js";
import { teardownSmoke } from "./host-smoke-teardown.js";

const USAGE =
  "usage: auto-harness host smoke <hostId> --repository-id <id> --repo-path <path> --provider <id|name> " +
  "[--provider <id|name>]... [--timeout <seconds>] [--json]";

// Copied from MAX_SESSION_TIMEOUT_SECONDS in modules/shared/src/validation.ts (7 days) — this
// package is dependency-free (no @auto-harness/shared import), so the value is duplicated here
// rather than imported. Keep in sync if the shared limit ever changes.
const MAX_SESSION_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

// A real provider turn is a full model round trip through a real host, not the quick one-shot
// prompt `session create`'s own 600s default assumes — generous, but still well inside the
// server's own ceiling above.
const DEFAULT_TIMEOUT_SECONDS = 300;

// Arbitrary, small: keeps the wait responsive without hammering the API (matches session
// create --wait's own poll interval).
const WAIT_POLL_INTERVAL_MS = 2_000;

function defaultRandomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(`${label} must be a positive number`);
  }
  return parsed;
}

function parseArgs(argv) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--repository-id", "--repo-path", "--timeout"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
    repeatableFlags: ["--provider"],
  });
  const [hostId] = positionals;
  const providers = flags["--provider"] ?? [];
  if (
    !hostId ||
    positionals.length > 1 ||
    !flags["--repository-id"] ||
    !flags["--repo-path"] ||
    providers.length === 0
  ) {
    throw new CliUsageError(USAGE);
  }
  const timeoutSeconds =
    flags["--timeout"] !== undefined
      ? parsePositiveNumber(flags["--timeout"], "--timeout")
      : DEFAULT_TIMEOUT_SECONDS;
  if (timeoutSeconds > MAX_SESSION_TIMEOUT_SECONDS) {
    throw new CliUsageError(`--timeout must be at most ${MAX_SESSION_TIMEOUT_SECONDS} seconds`);
  }
  return {
    flags,
    hostId,
    repositoryId: flags["--repository-id"],
    providers,
    repoPath: flags["--repo-path"],
    timeoutSeconds,
  };
}

/**
 * `host smoke <hostId> --repository-id <id> --repo-path <path> --provider <id|name>...
 * [--timeout <seconds>] [--json]` — uses an existing repository/host attachment to prove a
 * provider-routed session end to end. It changes no repository or host inventory. See
 * `modules/client/README.md` for the host-path preconditions.
 *
 * Every step logs `ok`/`FAIL` to stderr as it happens; stdout stays a clean final summary (or,
 * with `--json`, the full structured result). Teardown (`teardownSmoke`) always runs, in
 * `finally`, however far setup or the provider loop got. Exit 0 only when every provider passed
 * *and* teardown itself succeeded; 1 otherwise (a malformed invocation is the normal `CliUsageError`
 * path, exit 2, handled by `main.js` before this function is even called for that failure mode).
 */
export async function runHostSmoke(argv, io) {
  const { flags, hostId, repositoryId, providers, repoPath, timeoutSeconds } = parseArgs(argv);
  pathSegment(hostId, "hostId"); // validate before createClient, which may log in
  pathSegment(repositoryId, "repositoryId");
  const client = await createClient(flags, io);
  const randomHex = io.randomHex ?? defaultRandomHex;
  const sleep = io.sleep;
  const now = io.now;

  const activeSessionIds = new Set();
  let setupError;
  let teardownResult;
  const providerResults = [];

  try {
    const repository = await loadSmokeRepository(client, repositoryId);
    step(io, true, `verified existing repository ${repository.id} (${repository.name})`);

    await verifySmokeAttachment(client, hostId, repositoryId, repoPath);
    step(
      io,
      true,
      `verified repository ${repositoryId} is attached to host ${hostId} at ${repoPath}`,
    );

    const marker = `AH_SMOKE_${randomHex(8).toUpperCase()}`;
    for (const providerRef of providers) {
      const outcome = await runProviderSmoke({
        client,
        io,
        repositoryId,
        providerRef,
        marker,
        timeoutSeconds,
        activeSessionIds,
        sleep,
        now,
        intervalMs: WAIT_POLL_INTERVAL_MS,
      });
      providerResults.push(outcome);
    }
  } catch (error) {
    setupError = error;
    step(io, false, `setup: ${error.message}`);
  } finally {
    teardownResult = await teardownSmoke({ client, io, activeSessionIds });
  }

  const ok = !setupError && providerResults.every((provider) => provider.pass) && teardownResult.ok;
  const result = {
    hostId,
    repositoryId,
    providers: providerResults,
    teardown: teardownResult,
    ok,
    ...(setupError ? { setupError: setupError.message } : {}),
  };
  printSummary(io, flags, result);
  return ok ? 0 : 1;
}
