import { randomBytes } from "node:crypto";

import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { pathSegment } from "../path-segment.js";
import { attachRepository } from "./attach-repository.js";
import { printSummary, step } from "./host-smoke-format.js";
import { runProviderSmoke } from "./host-smoke-provider.js";
import { createSmokeRepository, smokeInventoryEntry } from "./host-smoke-repository.js";
import { teardownSmoke } from "./host-smoke-teardown.js";

const USAGE =
  "usage: auto-harness host smoke <hostId> --repo-path <path> --provider <id|name> " +
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
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--repo-path", "--timeout"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
    repeatableFlags: ["--provider"],
  });
  const [hostId] = positionals;
  const providers = flags["--provider"] ?? [];
  if (!hostId || positionals.length > 1 || !flags["--repo-path"] || providers.length === 0) {
    throw new CliUsageError(USAGE);
  }
  const timeoutSeconds =
    flags["--timeout"] !== undefined
      ? parsePositiveNumber(flags["--timeout"], "--timeout")
      : DEFAULT_TIMEOUT_SECONDS;
  if (timeoutSeconds > MAX_SESSION_TIMEOUT_SECONDS) {
    throw new CliUsageError(`--timeout must be at most ${MAX_SESSION_TIMEOUT_SECONDS} seconds`);
  }
  return { flags, hostId, providers, repoPath: flags["--repo-path"], timeoutSeconds };
}

/**
 * `host smoke <hostId> --repo-path <path> --provider <id|name>... [--timeout <seconds>]
 * [--json]` — proves a host can run a real provider-routed session end to end, then cleans up
 * after itself. See `modules/client/README.md` for the full step-by-step contract and the
 * preconditions on `--repo-path` this command cannot verify itself (it is a HOST path; the CLI
 * may run elsewhere).
 *
 * Every step logs `ok`/`FAIL` to stderr as it happens; stdout stays a clean final summary (or,
 * with `--json`, the full structured result). Teardown (`teardownSmoke`) always runs, in
 * `finally`, however far setup or the provider loop got. Exit 0 only when every provider passed
 * *and* teardown itself succeeded; 1 otherwise (a malformed invocation is the normal `CliUsageError`
 * path, exit 2, handled by `main.js` before this function is even called for that failure mode).
 */
export async function runHostSmoke(argv, io) {
  const { flags, hostId, providers, repoPath, timeoutSeconds } = parseArgs(argv);
  pathSegment(hostId, "hostId"); // validate before createClient, which may log in
  const client = await createClient(flags, io);
  const randomHex = io.randomHex ?? defaultRandomHex;
  const sleep = io.sleep;
  const now = io.now;

  const activeSessionIds = new Set();
  let repository;
  let attached = false;
  let setupError;
  let teardownResult;
  const providerResults = [];

  try {
    repository = await createSmokeRepository(client, randomHex);
    step(io, true, `created repository ${repository.id} (${repository.name})`);

    const entry = smokeInventoryEntry(repository, repoPath);
    await attachRepository(client, hostId, entry);
    attached = true;
    step(io, true, `attached repository ${repository.id} to host ${hostId} at ${repoPath}`);

    const marker = `AH_SMOKE_${randomHex(8).toUpperCase()}`;
    for (const providerRef of providers) {
      const outcome = await runProviderSmoke({
        client,
        io,
        repositoryId: repository.id,
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
    teardownResult = repository
      ? await teardownSmoke({
          client,
          io,
          hostId,
          repositoryId: repository.id,
          attached,
          activeSessionIds,
          sleep,
        })
      : {
          ok: true,
          cancelledSessionIds: [],
          uncancelledSessionIds: [],
          detached: false,
          repositoryDeleted: false,
        };
  }

  const ok = !setupError && providerResults.every((provider) => provider.pass) && teardownResult.ok;
  const result = {
    hostId,
    repositoryId: repository?.id,
    providers: providerResults,
    teardown: teardownResult,
    ok,
    ...(setupError ? { setupError: setupError.message } : {}),
  };
  printSummary(io, flags, result);
  return ok ? 0 : 1;
}
