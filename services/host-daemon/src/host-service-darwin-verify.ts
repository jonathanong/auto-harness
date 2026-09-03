import { failedCommand } from "./host-service-io.ts";
import type { HostServiceContext, HostServiceRunResult } from "./host-service-io.ts";
import { INSTALL_VERIFY_DELAY_SECONDS, inspectDarwin } from "./host-service-darwin-inspect.ts";
import type { LaunchInspection } from "./host-service-darwin-inspect.ts";

const INSTALL_VERIFY_RETRIES = 5;

export function isVerifiedReplacement(
  inspection: LaunchInspection,
  priorPid: string | undefined,
): boolean {
  return (
    inspection.status.state === "running" &&
    inspection.pid !== undefined &&
    (priorPid === undefined || inspection.pid !== priorPid)
  );
}

export function activationFailureReason(inspection: LaunchInspection): string {
  if (inspection.status.state === "running") {
    return inspection.pid === undefined
      ? "launch agent is running without a pid"
      : "launchd kept the prior daemon pid";
  }
  return inspection.status.reason;
}

export function waitForReplacement(
  ctx: HostServiceContext,
  priorPid: string | undefined,
  initial: LaunchInspection,
): LaunchInspection {
  let inspection = initial;
  for (
    let retry = 0;
    retry < INSTALL_VERIFY_RETRIES && !isVerifiedReplacement(inspection, priorPid);
    retry += 1
  ) {
    // launchctl kickstart -p waits for a launch, but launchctl print can still
    // briefly expose a transitional state. Keep this bounded and synchronous
    // because the platform service API intentionally returns an exit code.
    ctx.run("/bin/sleep", [INSTALL_VERIFY_DELAY_SECONDS]);
    inspection = inspectDarwin(ctx);
  }
  return inspection;
}

export function kickstartAndVerify(
  ctx: HostServiceContext,
  service: string,
  priorPid: string | undefined,
): number {
  const kick = ctx.run("launchctl", ["kickstart", "-k", service]);
  if (kick.status !== 0) return failedCommand(ctx.error, "launchctl kickstart -k", kick);
  const after = inspectDarwin(ctx);
  if (
    after.status.state !== "running" ||
    after.pid === undefined ||
    (priorPid !== undefined && after.pid === priorPid)
  ) {
    return failedCommand(ctx.error, "launchctl restart verification", {
      status: 1,
      stdout: "",
      stderr:
        after.status.state === "running" && after.pid === priorPid
          ? "launchd kept the prior daemon pid"
          : after.status.reason,
    });
  }
  return 0;
}

export type ActivationPassResult = {
  inspection: LaunchInspection;
  kick?: HostServiceRunResult;
  loaded: boolean;
  verified: boolean;
};
