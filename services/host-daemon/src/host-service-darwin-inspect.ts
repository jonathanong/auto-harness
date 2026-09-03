import type {
  HostServiceContext,
  HostServiceRunResult,
  HostServiceStatus,
} from "./host-service-io.ts";
import { DARWIN_LABEL } from "./host-service-templates.ts";

/** Shared launchctl poll cadence for both teardown waits and replacement verification. */
export const INSTALL_VERIFY_DELAY_SECONDS = "1";

export function launchDomain(uid: number): string {
  return `gui/${uid}`;
}

export function launchctlText(result: HostServiceRunResult): string {
  return `${result.stderr} ${result.stdout}`;
}

export type LaunchInspection = {
  status: HostServiceStatus;
  pid?: string;
};

export function inspectDarwin(ctx: HostServiceContext): LaunchInspection {
  const result = ctx.run(
    "launchctl",
    ["print", `${launchDomain(ctx.uid)}/${DARWIN_LABEL}`],
    ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs },
  );
  if (result.status !== 0) {
    const output = launchctlText(result).toLowerCase();
    return /could not find|not found|no such service/.test(output)
      ? { status: { state: "missing", reason: "launch agent is not installed" } }
      : { status: { state: "failed", reason: "launchctl status command failed" } };
  }
  const state = /^\s*state\s*=\s*(\S+)/m.exec(result.stdout)?.[1]?.toLowerCase();
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(result.stdout)?.[1];
  if (state === "running") {
    return {
      status: { state: "running", reason: "launch agent is running" },
      ...(pid ? { pid } : {}),
    };
  }
  if (state === "stopped" || state === "waiting") {
    return { status: { state: "stopped", reason: `launch agent is ${state}` } };
  }
  return { status: { state: "unknown", reason: "launchctl returned an unrecognized state" } };
}

export function statusDarwin(ctx: HostServiceContext): HostServiceStatus {
  return inspectDarwin(ctx).status;
}
