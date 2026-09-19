import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";
import { resolveSessionTarget } from "./session-target.js";
import { step } from "./host-smoke-format.js";
import { timeoutHint } from "./host-smoke-poll.js";
import { runSessionAttempts } from "./host-smoke-session-attempt.js";

/** Cancels a session smoke created and, either way, removes it from the shared
 * `activeSessionIds` bookkeeping the top-level teardown uses as its safety net — unless the
 * cancel call itself fails for a reason other than "already terminal" (409), in which case the
 * id is deliberately left in the set so `teardownSmoke` retries it at the end of the run. */
async function cancelForOutcome(client, io, sessionId, activeSessionIds) {
  try {
    await client.cancelSession(sessionId);
    activeSessionIds.delete(sessionId);
  } catch (error) {
    if (error instanceof AutoHarnessError && error.status === 409) {
      activeSessionIds.delete(sessionId); // raced to terminal on its own; nothing to cancel
      return;
    }
    io.stderr.write(
      `  session ${sessionId}: cancel failed (${error.message}); teardown will retry it\n`,
    );
  }
}

async function fetchStdout(client, sessionId) {
  const page = await client.request(`/sessions/${pathSegment(sessionId, "sessionId")}/logs`);
  return (page.items ?? [])
    .filter((item) => item.stream === "stdout")
    .map((item) => item.content)
    .join("\n");
}

/**
 * Runs one `--provider`'s end-to-end smoke session: resolve the target, then hand off to
 * `runSessionAttempts` (one create + wait), then check its logs. The daemon refreshes stale
 * inventory before acknowledging an assignment, so a just-attached repository needs no
 * client-side retry. Always
 * resolves to an outcome object — `{ provider, pass, ... }` — never throws or rejects, so a
 * bad `--provider` value or a mid-poll network blip fails only *this* provider rather than
 * aborting the ones after it; `host-smoke.js`'s loop relies on that to keep going.
 */
export async function runProviderSmoke({
  client,
  io,
  repositoryId,
  providerRef,
  marker,
  timeoutSeconds,
  activeSessionIds,
  sleep,
  now,
  intervalMs,
}) {
  let target;
  try {
    target = await resolveSessionTarget(client, { "--provider": providerRef });
  } catch (error) {
    step(io, false, `provider ${providerRef}: could not resolve target: ${error.message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "target_resolution_failed",
      message: error.message,
    };
  }

  const outcome = await runSessionAttempts({
    client,
    io,
    repositoryId,
    providerRef,
    target,
    marker,
    timeoutSeconds,
    activeSessionIds,
    sleep,
    now,
    intervalMs,
  });

  if (outcome.kind === "create_failed") {
    step(io, false, `provider ${providerRef}: create session failed: ${outcome.message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "create_failed",
      message: outcome.message,
    };
  }
  if (outcome.kind === "session_wait_failed") {
    step(io, false, `provider ${providerRef}: session wait failed: ${outcome.message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "session_wait_failed",
      sessionId: outcome.sessionId,
      message: outcome.message,
    };
  }
  if (outcome.kind === "usage_limit") {
    await cancelForOutcome(client, io, outcome.sessionId, activeSessionIds);
    const message = "provider account hit its usage limit";
    step(io, false, `provider ${providerRef}: ${message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "usage_limit",
      sessionId: outcome.sessionId,
      message,
    };
  }
  if (outcome.kind === "timeout") {
    await cancelForOutcome(client, io, outcome.sessionId, activeSessionIds);
    const hint = timeoutHint(outcome.session.status);
    step(io, false, `provider ${providerRef}: timed out after ${timeoutSeconds}s (${hint})`);
    return {
      provider: providerRef,
      pass: false,
      reason: "timeout",
      sessionId: outcome.sessionId,
      message: hint,
    };
  }

  // Terminal: already resolved on its own, nothing left for teardown to cancel.
  const { session, sessionId } = outcome;
  if (session.status !== "completed" || session.exitCode !== 0) {
    const detail = session.errorMessage ?? `exitCode=${session.exitCode ?? "n/a"}`;
    step(io, false, `provider ${providerRef}: session ${session.status} (${detail})`);
    return {
      provider: providerRef,
      pass: false,
      reason: "session_failed",
      sessionId,
      status: session.status,
      exitCode: session.exitCode,
      message: detail,
    };
  }

  let stdout;
  try {
    stdout = await fetchStdout(client, sessionId);
  } catch (error) {
    step(io, false, `provider ${providerRef}: fetching logs failed: ${error.message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "logs_failed",
      sessionId,
      message: error.message,
    };
  }
  if (!stdout.includes(marker)) {
    const message = "completed but marker was not found in stdout";
    step(io, false, `provider ${providerRef}: ${message}`);
    return { provider: providerRef, pass: false, reason: "marker_missing", sessionId, message };
  }

  step(io, true, `provider ${providerRef}: PASS`);
  return {
    provider: providerRef,
    pass: true,
    sessionId,
    status: session.status,
    exitCode: session.exitCode,
  };
}
