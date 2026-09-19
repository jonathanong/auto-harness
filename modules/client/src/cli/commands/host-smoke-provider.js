import { AutoHarnessError } from "../../index.js";
import { pathSegment } from "../path-segment.js";
import { resolveSessionTarget } from "./session-target.js";
import { step } from "./host-smoke-format.js";
import { timeoutHint, waitForSmokeSession } from "./host-smoke-poll.js";

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
 * Runs one `--provider`'s end-to-end smoke session: resolve the target, create the session,
 * wait for it (or a fast usage-limit signal, or a timeout), then check its logs. Always
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

  let created;
  try {
    created = await client.createSession({
      repositoryId,
      prompt: `Reply with exactly: ${marker}`,
      target,
      timeout: timeoutSeconds,
    });
  } catch (error) {
    step(io, false, `provider ${providerRef}: create session failed: ${error.message}`);
    return { provider: providerRef, pass: false, reason: "create_failed", message: error.message };
  }
  activeSessionIds.add(created.id);
  step(io, true, `provider ${providerRef}: created session ${created.id}`);

  const outcome = await waitForSmokeSession(client, created.id, {
    timeoutMs: timeoutSeconds * 1000,
    intervalMs,
    sleep,
    now,
    onStatus: (status) => io.stderr.write(`  session ${created.id}: ${status}\n`),
  });

  if (outcome.kind === "usage_limit") {
    await cancelForOutcome(client, io, created.id, activeSessionIds);
    const message = "provider account hit its usage limit";
    step(io, false, `provider ${providerRef}: ${message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "usage_limit",
      sessionId: created.id,
      message,
    };
  }
  if (outcome.kind === "timeout") {
    await cancelForOutcome(client, io, created.id, activeSessionIds);
    const hint = timeoutHint(outcome.session.status);
    step(io, false, `provider ${providerRef}: timed out after ${timeoutSeconds}s (${hint})`);
    return {
      provider: providerRef,
      pass: false,
      reason: "timeout",
      sessionId: created.id,
      message: hint,
    };
  }

  // Terminal: already resolved on its own, nothing left for teardown to cancel.
  activeSessionIds.delete(created.id);
  const { session } = outcome;
  if (session.status !== "completed" || session.exitCode !== 0) {
    const detail = session.errorMessage ?? `exitCode=${session.exitCode ?? "n/a"}`;
    step(io, false, `provider ${providerRef}: session ${session.status} (${detail})`);
    return {
      provider: providerRef,
      pass: false,
      reason: "session_failed",
      sessionId: created.id,
      status: session.status,
      exitCode: session.exitCode,
      message: detail,
    };
  }

  let stdout;
  try {
    stdout = await fetchStdout(client, created.id);
  } catch (error) {
    step(io, false, `provider ${providerRef}: fetching logs failed: ${error.message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "logs_failed",
      sessionId: created.id,
      message: error.message,
    };
  }
  if (!stdout.includes(marker)) {
    const message = "completed but marker was not found in stdout";
    step(io, false, `provider ${providerRef}: ${message}`);
    return {
      provider: providerRef,
      pass: false,
      reason: "marker_missing",
      sessionId: created.id,
      message,
    };
  }

  step(io, true, `provider ${providerRef}: PASS`);
  return {
    provider: providerRef,
    pass: true,
    sessionId: created.id,
    status: session.status,
    exitCode: session.exitCode,
  };
}
