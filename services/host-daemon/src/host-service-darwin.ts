/* eslint-disable max-lines -- launchd installation and verified restart share one lifecycle. */
import { join } from "node:path";

import { pathFromEnv, persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";
import type {
  HostServiceContext,
  HostServiceRunResult,
  HostServiceStatus,
} from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import { resolveUpdateInstallDir } from "./update-install-dir.ts";
import {
  DARWIN_LABEL,
  renderLaunchAgentPlist,
  renderUnixLaunchScript,
} from "./host-service-templates.ts";

const LAUNCHCTL_EALREADY = 37;
const INSTALL_ACTIVATION_PASSES = 2;
const INSTALL_VERIFY_RETRIES = 5;
const INSTALL_VERIFY_DELAY_SECONDS = "1";

function darwinPaths(home: string): {
  plist: string;
  envFile: string;
  launcher: string;
  log: string;
  agentsDir: string;
  supportDir: string;
} {
  const supportDir = join(home, "Library/Application Support/auto-harness");
  return {
    plist: join(home, "Library/LaunchAgents/com.auto-harness.host-daemon.plist"),
    envFile: join(supportDir, "host-daemon.env"),
    launcher: join(supportDir, "run-host-daemon.sh"),
    log: join(home, "Library/Logs/auto-harness-host-daemon.log"),
    agentsDir: join(home, "Library/LaunchAgents"),
    supportDir,
  };
}

function launchDomain(uid: number): string {
  return `gui/${uid}`;
}

function launchctlText(result: HostServiceRunResult): string {
  return `${result.stderr} ${result.stdout}`;
}

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

type LaunchInspection = {
  status: HostServiceStatus;
  pid?: string;
};

function inspectDarwin(ctx: HostServiceContext): LaunchInspection {
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

function loadLaunchAgent(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
): number {
  ctx.run("launchctl", ["bootout", service]);
  const boot = ctx.run("launchctl", ["bootstrap", domain, plist]);
  if (boot.status === 0) return 0;
  if (isLaunchctlAlreadyLoaded(boot)) {
    ctx.run("launchctl", ["bootout", service]);
    const retry = ctx.run("launchctl", ["bootstrap", domain, plist]);
    if (retry.status === 0) return 0;
  }
  const load = ctx.run("launchctl", ["load", "-w", plist]);
  if (load.status === 0 && !isLaunchctlLoadFailed(load)) return 0;
  return failedCommand(ctx.error, "launchctl bootstrap/load", load);
}

function kickstartAndVerify(
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

function isVerifiedReplacement(
  inspection: LaunchInspection,
  priorPid: string | undefined,
): boolean {
  return (
    inspection.status.state === "running" &&
    inspection.pid !== undefined &&
    (priorPid === undefined || inspection.pid !== priorPid)
  );
}

function activationFailureReason(inspection: LaunchInspection): string {
  if (inspection.status.state === "running") {
    return inspection.pid === undefined
      ? "launch agent is running without a pid"
      : "launchd kept the prior daemon pid";
  }
  return inspection.status.reason;
}

function waitForReplacement(
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

type ActivationPassResult = {
  inspection: LaunchInspection;
  kick?: HostServiceRunResult;
  loaded: boolean;
  verified: boolean;
};

function runActivationPass(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
  priorPid: string | undefined,
  initial: LaunchInspection,
): ActivationPassResult {
  if (loadLaunchAgent(ctx, domain, plist, service) !== 0) {
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

function activateLaunchAgent(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
): number {
  let inspection = inspectDarwin(ctx);
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
  let result: ActivationPassResult = {
    inspection,
    loaded: false,
    verified: false,
  };
  for (let pass = 0; pass < INSTALL_ACTIVATION_PASSES; pass += 1) {
    result = runActivationPass(ctx, domain, plist, service, priorPid, inspection);
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

function renderDarwinLauncher(ctx: HostServiceContext): string {
  const updateRoot = resolveUpdateInstallDir(ctx.env, {
    platform: ctx.platform,
    home: ctx.home,
    appData: ctx.appData,
  });
  const currentRoot = join(updateRoot, "current");
  return renderUnixLaunchScript({
    nodePath: ctx.nodePath,
    currentRoot,
    currentLauncherPath: join(currentRoot, "services/host-daemon/bin/auto-harness-host-daemon.mjs"),
    fallbackRoot: ctx.checkoutRoot,
    fallbackLauncherPath: ctx.launcherPath,
    prepareLauncherPath: ctx.launcherPath,
  });
}

export function installDarwin(ctx: HostServiceContext): number {
  const paths = darwinPaths(ctx.home);
  const envExists = ctx.fs.existsSync(paths.envFile);
  const existingEnv = envExists ? ctx.fs.readFileSync(paths.envFile) : undefined;
  const preparedEnv = preparePersistedEnv({
    existing: existingEnv,
    example: ctx.fs.readFileSync(ctx.envExamplePath),
    env: ctx.env,
    apiUrl: ctx.apiUrl,
  });
  if (preparedEnv.errors.length > 0) {
    ctx.error(persistedEnvError(preparedEnv.errors));
    return 1;
  }
  ctx.fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o755 });
  ctx.fs.mkdirSync(paths.supportDir, { recursive: true, mode: 0o755 });
  if (envExists && ctx.apiUrl === undefined && preparedEnv.contents === existingEnv) {
    ctx.log(`Keeping existing env file ${paths.envFile}`);
  } else {
    writeMode(ctx.fs, paths.envFile, preparedEnv.contents, 0o600, !envExists);
    ctx.log(`${envExists ? "Updated" : "Wrote"} ${paths.envFile} (mode 0600)`);
  }
  writeMode(ctx.fs, paths.launcher, renderDarwinLauncher(ctx), 0o700);
  ctx.log(`Wrote ${paths.launcher}`);
  writeMode(
    ctx.fs,
    paths.plist,
    renderLaunchAgentPlist({
      nodePath: ctx.nodePath,
      launcherPath: ctx.launcherPath,
      checkoutRoot: ctx.checkoutRoot,
      home: ctx.home,
      envFilePath: paths.envFile,
      pathValue: pathFromEnv(ctx.env) ?? "/usr/local/bin:/usr/bin:/bin",
      logPath: paths.log,
      programArguments: ["/bin/sh", paths.launcher],
    }),
    0o644,
  );
  ctx.log(`Wrote ${paths.plist}`);
  const domain = launchDomain(ctx.uid);
  const service = `${domain}/${DARWIN_LABEL}`;
  const activated = activateLaunchAgent(ctx, domain, paths.plist, service);
  if (activated !== 0) return activated;
  ctx.log(`Enabled LaunchAgent ${DARWIN_LABEL} as the current user`);
  return 0;
}

export function restartDarwin(ctx: HostServiceContext): number {
  const service = `${launchDomain(ctx.uid)}/${DARWIN_LABEL}`;
  const restarted = kickstartAndVerify(ctx, service, inspectDarwin(ctx).pid);
  if (restarted !== 0) return restarted;
  ctx.log(`Restarted LaunchAgent ${DARWIN_LABEL}`);
  return 0;
}

export function uninstallDarwin(ctx: HostServiceContext): number {
  const paths = darwinPaths(ctx.home);
  const domain = launchDomain(ctx.uid);
  ctx.run("launchctl", ["bootout", `${domain}/${DARWIN_LABEL}`]);
  ctx.run("launchctl", ["unload", "-w", paths.plist]);
  if (ctx.fs.existsSync(paths.plist)) {
    ctx.fs.rmSync(paths.plist, { force: true });
    ctx.log(`Removed ${paths.plist}`);
  }
  ctx.log(`Disabled LaunchAgent ${DARWIN_LABEL} (checkout and env file left in place)`);
  return 0;
}
