import { join } from "node:path";

import { pathFromEnv, persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";
import type {
  HostServiceContext,
  HostServiceRunResult,
  HostServiceStatus,
} from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import { DARWIN_LABEL, renderLaunchAgentPlist } from "./host-service-templates.ts";

const LAUNCHCTL_EALREADY = 37;

function darwinPaths(home: string): {
  plist: string;
  envFile: string;
  log: string;
  agentsDir: string;
  supportDir: string;
} {
  return {
    plist: join(home, "Library/LaunchAgents/com.auto-harness.host-daemon.plist"),
    envFile: join(home, "Library/Application Support/auto-harness/host-daemon.env"),
    log: join(home, "Library/Logs/auto-harness-host-daemon.log"),
    agentsDir: join(home, "Library/LaunchAgents"),
    supportDir: join(home, "Library/Application Support/auto-harness"),
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

function isKickstartAlreadyInProgress(result: HostServiceRunResult): boolean {
  return result.status === LAUNCHCTL_EALREADY || /already in progress/i.test(launchctlText(result));
}

function isLaunchAgentPresent(status: HostServiceStatus): boolean {
  return status.state !== "missing" && status.state !== "failed";
}

export function statusDarwin(ctx: HostServiceContext): HostServiceStatus {
  const result = ctx.run(
    "launchctl",
    ["print", `${launchDomain(ctx.uid)}/${DARWIN_LABEL}`],
    ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs },
  );
  if (result.status !== 0) {
    const output = launchctlText(result).toLowerCase();
    return /could not find|not found|no such service/.test(output)
      ? { state: "missing", reason: "launch agent is not installed" }
      : { state: "failed", reason: "launchctl status command failed" };
  }
  const state = /^\s*state\s*=\s*(\S+)/m.exec(result.stdout)?.[1]?.toLowerCase();
  if (state === "running") return { state: "running", reason: "launch agent is running" };
  if (state === "stopped" || state === "waiting") {
    return { state: "stopped", reason: `launch agent is ${state}` };
  }
  return { state: "unknown", reason: "launchctl returned an unrecognized state" };
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
  if (load.status === 0) return 0;
  return failedCommand(ctx.error, "launchctl bootstrap/load", load);
}

function recoverLaunchAgent(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
  kick: HostServiceRunResult,
): number {
  const status = statusDarwin(ctx);
  if (status.state === "stopped" && kick.status !== 0 && !isKickstartAlreadyInProgress(kick)) {
    return failedCommand(ctx.error, "launchctl kickstart", kick);
  }
  if (isLaunchAgentPresent(status)) return 0;
  if (loadLaunchAgent(ctx, domain, plist, service) !== 0) return 1;
  const after = statusDarwin(ctx);
  if (isLaunchAgentPresent(after)) return 0;
  if (kick.status !== 0 && !isKickstartAlreadyInProgress(kick)) {
    return failedCommand(ctx.error, "launchctl kickstart", kick);
  }
  return failedCommand(ctx.error, "launchctl verification", {
    status: 1,
    stdout: "",
    stderr: after.reason,
  });
}

function activateLaunchAgent(
  ctx: HostServiceContext,
  domain: string,
  plist: string,
  service: string,
): number {
  if (loadLaunchAgent(ctx, domain, plist, service) !== 0) return 1;
  let status = statusDarwin(ctx);
  if (!isLaunchAgentPresent(status)) {
    if (loadLaunchAgent(ctx, domain, plist, service) !== 0) return 1;
    status = statusDarwin(ctx);
  }
  if (status.state === "running") return 0;
  const kick = ctx.run("launchctl", ["kickstart", service]);
  if (kick.status !== 0 && !isKickstartAlreadyInProgress(kick)) {
    return recoverLaunchAgent(ctx, domain, plist, service, kick);
  }
  status = statusDarwin(ctx);
  if (isLaunchAgentPresent(status)) return 0;
  return recoverLaunchAgent(ctx, domain, plist, service, kick);
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
  if (envExists && ctx.apiUrl === undefined) {
    ctx.log(`Keeping existing env file ${paths.envFile}`);
  } else {
    writeMode(ctx.fs, paths.envFile, preparedEnv.contents, 0o600, !envExists);
    ctx.log(`${envExists ? "Updated" : "Wrote"} ${paths.envFile} (mode 0600)`);
  }
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
  const kick = ctx.run("launchctl", ["kickstart", service]);
  if (kick.status !== 0 && !isKickstartAlreadyInProgress(kick)) {
    return failedCommand(ctx.error, "launchctl kickstart", kick);
  }
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
