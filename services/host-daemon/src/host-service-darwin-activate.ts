import { failedCommand } from "./host-service-io.ts";
import type { HostServiceContext, HostServiceRunResult } from "./host-service-io.ts";
import {
  INSTALL_VERIFY_DELAY_SECONDS,
  inspectDarwin,
  launchctlText,
} from "./host-service-darwin-inspect.ts";
import type { LaunchInspection } from "./host-service-darwin-inspect.ts";
import {
  activationFailureReason,
  isVerifiedReplacement,
  waitForReplacement,
} from "./host-service-darwin-verify.ts";
import type { ActivationPassResult } from "./host-service-darwin-verify.ts";

export { kickstartAndVerify } from "./host-service-darwin-verify.ts";

const LAUNCHCTL_EALREADY = 37;
const INSTALL_ACTIVATION_PASSES = 2;
/**
 * `launchctl bootout` only signals a job; launchd can take several seconds to
 * actually deregister it (its own log reports "scheduling cleanup in 60 sec"
 * after the SIGTERM). Every `bootstrap` issued before that finishes fails
 * with 37/EALREADY, so wait for the label to disappear instead of a fixed
 * sleep. This budget is shared across bootout/bootstrap retries and both
 * activation passes; 90 x 1s covers a normal drain (daemon-loop's default
 * drainDeadlineMs is 30s) with ample margin. The plist's ExitTimeOut (900s)
 * means launchd can in principle take much longer to force-kill a wedged
 * process; if that budget is exhausted the installer still falls back to
 * `load -w` exactly as before, just with a clearer error.
 */
const TEARDOWN_POLL_ATTEMPTS = 90;

function isLaunchctlAlreadyLoaded(result: HostServiceRunResult): boolean {
  return (
    result.status === 5 ||
    result.status === LAUNCHCTL_EALREADY ||
    /already (?:been )?loaded|already exists|already in progress|input\/output error/i.test(
      launchctlText(result),
    )
  );
}

function isLaunchctlLoadFailed(result: HostServiceRunResult): boolean {
  return /\bload failed\b/i.test(launchctlText(result));
}

type TeardownBudget = { attemptsLeft: number };

/** Poll until launchd reports the job missing, or the shared budget runs out. */
function waitForRemoval(ctx: HostServiceContext, budget: TeardownBudget): void {
  let inspection = inspectDarwin(ctx);
  while (inspection.status.state !== "missing" && budget.attemptsLeft > 0) {
    ctx.run("/bin/sleep", [INSTALL_VERIFY_DELAY_SECONDS]);
    budget.attemptsLeft -= 1;
    inspection = inspectDarwin(ctx);
  }
}

/** Surface launchd's real bootstrap failure alongside the masked load -w result. */
function withLastBootstrap(
  load: HostServiceRunResult,
  bootstrap: HostServiceRunResult,
): HostServiceRunResult {
  const detail = bootstrap.stderr.trim() || bootstrap.stdout.trim();
  return detail ? { ...load, stderr: `${load.stderr} (last bootstrap: ${detail})` } : load;
}

function loadLaunchAgent(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
  wasLoaded: boolean,
  budget: TeardownBudget,
): number {
  ctx.run("launchctl", ["bootout", service]);
  if (wasLoaded) waitForRemoval(ctx, budget);
  let attempt = ctx.run("launchctl", ["bootstrap", domain, plist]);
  if (attempt.status === 0) return 0;
  while (isLaunchctlAlreadyLoaded(attempt) && budget.attemptsLeft > 0) {
    budget.attemptsLeft -= 1;
    ctx.run("launchctl", ["bootout", service]);
    waitForRemoval(ctx, budget);
    attempt = ctx.run("launchctl", ["bootstrap", domain, plist]);
    if (attempt.status === 0) return 0;
  }
  ctx.run("/bin/sleep", [INSTALL_VERIFY_DELAY_SECONDS]);
  const load = ctx.run("launchctl", ["load", "-w", plist]);
  if (load.status === 0 && !isLaunchctlLoadFailed(load)) return 0;
  return failedCommand(ctx.error, "launchctl bootstrap/load", withLastBootstrap(load, attempt));
}

function runActivationPass(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
  priorPid: string | undefined,
  initial: LaunchInspection,
  wasLoaded: boolean,
  budget: TeardownBudget,
): ActivationPassResult {
  if (loadLaunchAgent(ctx, domain, plist, service, wasLoaded, budget) !== 0) {
    return { inspection: initial, loaded: false, verified: false };
  }
  let inspection = inspectDarwin(ctx);
  if (isVerifiedReplacement(inspection, priorPid)) {
    return { inspection, loaded: true, verified: true };
  }
  let kick: HostServiceRunResult | undefined;
  if (inspection.status.state === "stopped" || inspection.status.state === "unknown") {
    kick = ctx.run("launchctl", ["kickstart", "-p", service]);
    inspection = inspectDarwin(ctx);
  }
  if (inspection.status.state !== "missing" && inspection.status.state !== "failed") {
    inspection = waitForReplacement(ctx, priorPid, inspection);
  }
  return {
    inspection,
    ...(kick === undefined ? {} : { kick }),
    loaded: true,
    verified: isVerifiedReplacement(inspection, priorPid),
  };
}

export function activateLaunchAgent(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
): number {
  const inspection = inspectDarwin(ctx);
  if (
    inspection.status.state === "failed" ||
    (inspection.status.state === "running" && inspection.pid === undefined)
  ) {
    return failedCommand(ctx.error, "launchctl pre-reload verification", {
      status: 1,
      stdout: "",
      stderr: activationFailureReason(inspection),
    });
  }
  const priorPid = inspection.pid;
  const wasLoaded = inspection.status.state !== "missing";
  const budget: TeardownBudget = { attemptsLeft: TEARDOWN_POLL_ATTEMPTS };
  let result: ActivationPassResult = {
    inspection,
    loaded: false,
    verified: false,
  };
  for (let pass = 0; pass < INSTALL_ACTIVATION_PASSES; pass += 1) {
    result = runActivationPass(
      ctx,
      domain,
      plist,
      service,
      priorPid,
      inspection,
      pass === 0 ? wasLoaded : true,
      budget,
    );
    if (!result.loaded) return 1;
    if (result.verified) return 0;
    if (pass + 1 < INSTALL_ACTIVATION_PASSES) {
      ctx.log("LaunchAgent activation was not verified; retrying reload");
    }
  }
  if (result.kick !== undefined && result.kick.status !== 0) {
    return failedCommand(ctx.error, "launchctl kickstart -p", result.kick);
  }
  return failedCommand(ctx.error, "launchctl verification", {
    status: 1,
    stdout: "",
    stderr: activationFailureReason(result.inspection),
  });
}
